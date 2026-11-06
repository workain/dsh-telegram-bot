import {hasLiveSubagentOwner} from './session-api.js';
import {isKnownTelegramRejection} from './topic-recovery.js';

/**
 * Source-independent, live-only Session observer. No Host or Telegram imports.
 *
 * Contract:
 * createSessionWatch({ctx, getPolicy, ensureTopic, send, persist, getState, onError})
 * - ctx.on('session/event', (session,event) => void) returns an unsubscribe fn;
 *   ctx.sessionController.list({}, AbortSignal) -> {items: SessionSummary[]};
 *   ctx.workspaceRegistry.list() -> Workspace[]; archivedSessionIds -> string[].
 * - getPolicy() -> {enabled, allowed, chatId, workspaceIds, boundSessionIds?}.
 *   Both booleans must be true. boundSessionIds explicitly opts a manual binding
 *   into observation, but never bypasses registered membership/root/archive gates.
 * - getState() returns the SAME mutable JSON watch namespace for this instance.
 *   Owns bindings, bindingErrors and sessions; persist() durably saves that object.
 * - ensureTopic(sessionId,chatId) -> Promise<{chatId,threadId,sessionId}>.
 *   Parent owns topic creation/recovery. An uncertain failure is latched in
 *   bindingErrors[JSON.stringify([chatId,sessionId])]; reconcile manually and
 *   clear it before retrying. Never silently retry an ambiguous create.
 * - send(chat,text) -> Promise<void>; parent handles formatting/splits. Common
 *   credential patterns are redacted here (best effort, NOT a privacy guarantee).
 * - onError(error,{operation,sessionId?}) is isolated (including async failures).
 *
 * Returns {start,reconcile,refresh,idle,drain,dispose}. start is idempotent and
 * subscribes BEFORE scanning running nonblank sessions; reconcile/refresh scan
 * again without reading history. idle/drain await current queued work. dispose
 * synchronously unsubscribes, aborts list and gates queued work; returns idle().
 * No timers. Each session is FIFO; different sessions can progress independently.
 * Progress coalesces repeated tool names and sends at most ten updates per turn.
 * Drafts are capped at 16000 Unicode codepoints plus a truncation marker.
 * Archive/membership admission accepts both raw and session-prefixed identities.
 * Subagent origin/positive delegation depth are excluded; ordinary user forks
 * remain eligible despite parentSession/parentSessionId/isSeeded seed lineage.
 * Policy/membership are reread before creation and every send, including after
 * asynchronous creation. Already dispatched network calls cannot be recalled.
 *
 * sessions[id] stores a successful contiguous cursor, sparse handled seqs after
 * failures, and turn-local text drafts. Only committed assistant text without
 * tool calls is eligible; turn/end emits that turn's last eligible message plus
 * a whitelisted reason, NOT completion of an entire goal. No history replay.
 * Successful sends precede persistence: crashes/timeouts may duplicate delivery;
 * neither this module nor Telegram can promise exactly-once network effects.
 */
function redact(text) {
  return text
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED]')
    .replace(/\b([A-Za-z_][\w]*(?:KEY|TOKEN|PASSWORD|SECRET)|KEY|TOKEN|PASSWORD|SECRET)(\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      '$1$2[REDACTED]');
}

export const redactTelegramText = redact;
const canonicalSessionId = id => String(id).replace(/^session-/, '');
function boundedText(text) {
  let result = '', count = 0;
  for (const point of redact(text)) {
    if (count++ === 16000) return `${result}\n[Truncated]`;
    result += point;
  }
  return result;
}

export function createSessionWatch({ctx, getPolicy, ensureTopic, send, persist, getState, onError = () => {}}) {
  const state = getState();
  state.bindings ??= {};
  state.bindingErrors ??= {};
  state.sessions ??= {};
  const queues = new Map();
  const topics = new Map();
  // A persistence failure must not create a second topic in this process.
  const confirmedTopics = new Map();
  const uncertainTopics = new Set();
  const jobs = new Set();
  const abort = new AbortController();
  let disposed = false;
  let started = false;
  let unsubscribe;
  let scan;
  let saving = Promise.resolve();

  function report(error, operation, sessionId) {
    try { Promise.resolve(onError(error, {operation, sessionId})).catch(() => {}); }
    catch { /* Error reporting must never escape into the agent. */ }
  }
  function track(promise) {
    jobs.add(promise);
    promise.then(() => jobs.delete(promise), () => jobs.delete(promise));
    return promise;
  }
  function enqueue(id, work) {
    const promise = (queues.get(id) ?? Promise.resolve()).then(() => {
      if (!disposed) return work();
    }).catch(error => report(error, 'event', id));
    queues.set(id, promise);
    promise.then(() => { if (queues.get(id) === promise) queues.delete(id); });
    return track(promise);
  }
  // Serialize durable updates without holding this lock across network IO.
  function commit(change) {
    const promise = saving.then(async () => {
      const before = structuredClone(state);
      change();
      try { await persist(); }
      catch (error) {
        for (const key of Object.keys(state)) delete state[key];
        Object.assign(state, before);
        throw error;
      }
    });
    saving = promise.catch(() => {});
    return promise;
  }
  const snapshot = policy => ({generation: policy.generation ?? 0, chatId: policy.chatId});
  function policyFor(id, session, expected) {
    if (disposed) return null;
    const policy = getPolicy();
    if (policy?.enabled !== true || policy.allowed !== true ||
        !Number.isSafeInteger(policy.chatId)) return null;
    if (expected && ((policy.generation ?? 0) !== expected.generation || policy.chatId !== expected.chatId)) return null;
    const header = session?.header ?? session?.meta ?? session;
    // A user fork can have parentSession/isSeeded without subagent ownership.
    if (!header || hasLiveSubagentOwner(ctx, id, header) || (header.delegationDepth ?? 0) > 0) return null;
    const registry = ctx.get?.('workspaceRegistry') ?? ctx.workspaceRegistry;
    if (!registry?.list) throw new Error('Workspace registry unavailable for session delivery');
    const canonical = canonicalSessionId(id);
    const matches = value => canonicalSessionId(value) === canonical;
    if ((registry.archivedSessionIds ?? []).some(matches)) return null;
    const memberships = registry.list().filter(workspace => (workspace.sessionIds ?? []).some(matches));
    const manual = (policy.boundSessionIds ?? []).some(matches);
    if (!memberships.some(workspace => manual || (policy.workspaceIds ?? []).includes(workspace.id))) return null;
    return policy;
  }
  function keyFor(id, chatId) { return JSON.stringify([chatId, id]); }
  function validChat(chat, id, chatId) {
    return chat && chat.chatId === chatId && chat.sessionId === id && Number.isSafeInteger(chat.threadId);
  }
  async function binding(id, session, expected) {
    const policy = policyFor(id, session, expected);
    if (!policy) return null;
    const key = keyFor(id, policy.chatId);
    const saved = state.bindings[key] ?? confirmedTopics.get(key);
    if (saved) {
      if (!validChat(saved, id, policy.chatId)) throw new Error('Invalid persisted topic binding');
      if (!state.bindings[key]) await commit(() => { state.bindings[key] = saved; });
      return policyFor(id, session, expected) ? saved : null;
    }
    if (state.bindingErrors[key] || uncertainTopics.has(key)) return null;
    if (topics.has(key)) return topics.get(key);
    const promise = (async () => {
      if (policyFor(id, session, expected)?.chatId !== policy.chatId) return null;
      let chat;
      try {
        chat = await ensureTopic(id, policy.chatId);
        if (!chat || chat.chatId !== policy.chatId || chat.sessionId !== id ||
            !Number.isSafeInteger(chat.threadId)) throw new Error('Invalid topic binding');
      } catch (error) {
        if (isKnownTelegramRejection(error)) throw error;
        uncertainTopics.add(key);
        await commit(() => { state.bindingErrors[key] = {chatId: policy.chatId, sessionId: id}; });
        uncertainTopics.delete(key);
        throw error;
      }
      // Retain a created topic even if access was revoked during creation.
      confirmedTopics.set(key, chat);
      await commit(() => { state.bindings[key] = chat; });
      return policyFor(id, session, expected)?.chatId === chat.chatId ? chat : null;
    })();
    topics.set(key, promise);
    try { return await promise; }
    finally { topics.delete(key); }
  }
  async function output(id, session, text, expected) {
    const chat = await binding(id, session, expected);
    if (!chat || policyFor(id, session, expected)?.chatId !== chat.chatId) return false;
    await send(chat, redact(text));
    return policyFor(id, session, expected) !== null;
  }
  function sessionRecord(id, seq, expected) {
    const saved = state.sessions[id];
    if (saved && (saved.generation ?? 0) === expected.generation) {
      const value = structuredClone(saved);
      const floor = getPolicy().historyThroughSeqs?.[id];
      if (Number.isSafeInteger(floor) && floor > value.cursor) {
        value.cursor = floor; value.handled = value.handled.filter(seq => seq > floor); value.turns = {};
      }
      return value;
    }
    // New consent boundary: never carry off-period gaps or draft text forward.
    return {cursor: seq - 1, handled: [], turns: {}, generation: expected.generation};
  }
  const reasons = new Set(['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']);
  async function handle(session, event, expected) {
    const id = session.id ?? session.sessionId;
    if (!policyFor(id, session, expected)) return;
    const seq = event.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    if (getPolicy().mirrorMessages === true && ['turn/start', 'user/message', 'assistant/message', 'tool/call', 'turn/end'].includes(event.type)) {
      if (!await binding(id, session, expected)) return;
      const floor = getPolicy().historyThroughSeqs?.[id];
      if (Number.isSafeInteger(floor) && seq <= floor) return;
    }
    const record = sessionRecord(id, seq, expected);
    if (seq <= record.cursor || record.handled.includes(seq)) return;
    // Establish the live subscription boundary before any fallible side effect.
    if (!state.sessions[id]) await commit(() => { state.sessions[id] = record; });
    const data = event.data ?? {};
    const turn = Number.isSafeInteger(data.turn) ? String(data.turn) : null;
    if (event.type === 'turn/start' && turn !== null) {
      if (!await binding(id, session, expected)) return;
      record.turns[turn] ??= {text: ''};
    } else if (event.type === 'user/message' && getPolicy().mirrorMessages === true) {
      // Mirror only actual human input, never system injections or goal drivers.
      const source = data.source;
      const own = typeof source?.rpcId === 'string' && source.rpcId.startsWith(`telegram:${getPolicy().chatId}:`);
      const text = boundedText((data.content ?? []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim());
      if (source?.kind === 'user' && text) {
        if (!own && !await output(id, session, `👤 DSH\n${text}`, expected)) return;
        record.deliveredMessages ??= []; record.deliveredMessages.push(seq);
      }
    } else if (event.type === 'assistant/message' && turn !== null) {
      const content = data.message?.content;
      if (Array.isArray(content)) {
        const hasTools = content.some(block => block.type === 'tool-call');
        // Clear previous candidates on a new tool-request message; never emit
        // its preamble as an answer when a later step fails.
        const text = boundedText(content.filter(block => block.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join('\n').trim());
        if (getPolicy().mirrorMessages === true) {
          if (text) {
            if (!await output(id, session, `🤖 ${text}`, expected)) return;
            record.deliveredMessages ??= []; record.deliveredMessages.push(seq);
          }
          record.turns[turn] = {...record.turns[turn], text: ''};
        } else record.turns[turn] = {...record.turns[turn], text: hasTools ? '' : text};
      }
    } else if (event.type === 'tool/call' && getPolicy().showToolCalls !== false) {
      // Names are identifiers, not arbitrary free-form progress descriptions.
      const name = typeof data.name === 'string' && /^[\w./:-]{1,80}$/.test(data.name)
        ? data.name : 'tool';
      const draft = record.turns[turn ?? 'unknown'] ??= {text: ''};
      const progress = draft.progress ?? {count: 0, last: null};
      if (progress.count < 10 && progress.last !== name) {
        if (!await output(id, session, `Tool: ${name}`, expected)) return;
        draft.progress = {count: progress.count + 1, last: name};
      }
    } else if (event.type === 'turn/end' && turn !== null) {
      const text = record.turns[turn]?.text ?? '';
      const reason = reasons.has(data.reason?.kind) ? data.reason.kind : 'ended';
      if (!await output(id, session, `${text ? `${text}\n\n` : ''}Turn ${turn}: ${reason}`, expected)) return;
      delete record.turns[turn];
    }
    // Advance only successfully handled records. Sparse successes keep a failed
    // event retryable even when later events have already been delivered.
    record.handled.push(seq);
    record.handled.sort((a, b) => a - b);
    while (record.handled[0] === record.cursor + 1) record.cursor = record.handled.shift();
    await commit(() => { state.sessions[id] = record; });
  }
  function listener(session, event) {
    // Deliberately returns undefined: Host/model never awaits transport.
    try {
      if (disposed || !session || !event) return;
      const id = session.id ?? session.sessionId;
      if (typeof id !== 'string') return;
      const policy = policyFor(id, session);
      if (!policy) return; // Never enqueue content arriving while disabled.
      const expected = snapshot(policy);
      enqueue(id, () => handle(session, event, expected));
    } catch (error) { report(error, 'listener'); }
  }
  function reconcile() {
    if (disposed) return Promise.resolve();
    if (scan) return scan;
    scan = track((async () => {
      const controller = ctx.get?.('sessionController') ?? ctx.sessionController;
      if (!controller?.list) throw new Error('Session controller unavailable for session delivery');
      const result = await controller.list({}, abort.signal);
      for (const summary of result.items) {
        if (disposed) break;
        const policy = policyFor(summary.sessionId, summary);
        if (summary.running && summary.blank === false && policy) {
          const expected = snapshot(policy);
          enqueue(summary.sessionId, () => binding(summary.sessionId, summary, expected));
        }
      }
    })().catch(error => { if (!disposed) report(error, 'reconcile'); }).finally(() => { scan = null; }));
    return scan;
  }
  function start() {
    if (!started && !disposed) {
      started = true;
      try { unsubscribe = ctx.on('session/event', listener, {global: true}); }
      catch (error) { started = false; report(error, 'subscribe'); return Promise.resolve(); }
      return reconcile();
    }
    return scan ?? Promise.resolve();
  }
  async function idle() {
    while (jobs.size) await Promise.allSettled([...jobs]);
    await saving;
  }
  function dispose() {
    if (!disposed) {
      disposed = true;
      abort.abort();
      try { if (typeof unsubscribe === 'function') unsubscribe(); }
      catch (error) { report(error, 'unsubscribe'); }
    }
    return idle();
  }
  async function recoverBinding(sessionId, chatId) {
    const key = keyFor(sessionId, chatId);
    if (state.bindings[key] || confirmedTopics.has(key) || topics.has(key)) throw new Error('Existing or in-flight binding cannot be reset');
    uncertainTopics.delete(key);
    await commit(() => { delete state.bindingErrors[key]; });
  }
  return {start, reconcile, refresh: reconcile, idle, drain: idle, dispose, recoverBinding};
}
