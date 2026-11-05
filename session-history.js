import {redactTelegramText} from './session-watch.js';

/**
 * Cold, native session transcript reader. Never follows/activates an agent.
 * getState(chat) returns the SAME durable JSON history namespace per binding;
 * getBinding(chat) returns its current canonical {chatId,threadId,sessionId}.
 * isAllowed(chat) and getBinding are synchronous. persist() saves state.
 * send(chat,text) resolves only for successful delivery; parent owns Telegram
 * filtering, escaping and the older-history button. Optional isLiveDelivered
 * (chat,seq) is synchronous. No exactly-once guarantee across network crashes.
 *
 * recent/older(chat,signal) -> {sent,hasMore,beforeSeq,throughSeq,initial}.
 * sent counts fully delivered transcript messages, not Telegram requests.
 * initial identifies the first unfinished recent load. recent is idempotent
 * after completion; older continues the frozen cut, including cutoff records.
 * State owns throughSeq, beforeSeq (exclusive), hasMore, cutoff,
 * initialComplete, sentSeqs and sentParts (partial long-message delivery).
 * now() and maxMessages (default 200) are optional test/budget overrides.
 * idle() waits for all currently queued operations (errors reach callers).
 */
export function createSessionHistory({ctx, getState, getBinding, isAllowed, send, persist,
  isLiveDelivered = () => false, now = Date.now, maxMessages = 200}) {
  if (!Number.isSafeInteger(maxMessages) || maxMessages < 1) throw new Error('Invalid history maxMessages');
  const queues = new Map();
  const key = chat => JSON.stringify([chat.chatId, chat.threadId, chat.sessionId]);
  function check(chat, signal) {
    if (signal?.aborted) throw signal.reason ?? new Error('History request cancelled');
    const binding = getBinding(chat);
    if (!isAllowed(chat) || !binding || binding.chatId !== chat.chatId ||
        binding.threadId !== chat.threadId || binding.sessionId !== chat.sessionId) {
      throw new Error('History access revoked or topic binding changed');
    }
  }
  function api() {
    // Cordis resolves services only once the plugin lifecycle is active.
    const controller = ctx.get?.('sessionController') ?? ctx.sessionController;
    if (typeof controller?.projections !== 'function' || typeof controller?.page !== 'function') {
      throw new Error('DSH native sessionController.projections/page history API is required');
    }
    return controller;
  }
  async function save(chat, state, changes, signal) {
    check(chat, signal);
    const before = structuredClone(state);
    Object.assign(state, changes);
    try { await persist(); }
    catch (error) {
      for (const field of Object.keys(state)) delete state[field];
      Object.assign(state, before);
      throw error;
    }
    check(chat, signal);
  }
  const result = (state, sent, initial) => ({sent, hasMore: state.hasMore === true,
    beforeSeq: state.beforeSeq ?? null, throughSeq: state.throughSeq ?? null, initial});

  function transcript(event) {
    let blocks, role;
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      blocks = event.data.content;
      role = '👤 Пользователь';
    } else if (event.type === 'assistant/message') {
      blocks = event.data?.message?.content;
      role = '🤖 Ассистент';
    } else return null;
    if (!Array.isArray(blocks)) return null;
    let text = blocks.filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n').trim();
    if (!text) return null;
    text = redactTelegramText(text);
    const points = Array.from(text);
    if (points.length > 16000) text = `${points.slice(0, 16000).join('')}\n[Сокращено]`;
    const time = typeof event.time === 'number' || typeof event.time === 'string'
      ? new Date(event.time).getTime() : NaN;
    const date = Number.isFinite(time) ? new Date(time).toISOString() : 'дата неизвестна';
    return {seq: event.seq, time, text: `История · ${date} · ${role}\n${text}`};
  }

  // Keep chunks below Telegram's UTF-16 limit, without splitting surrogate pairs.
  function fragments(message) {
    const pieces = [];
    let text = '';
    for (const point of message.text) {
      if (text.length + point.length > 3400) { pieces.push(text); text = ''; }
      text += point;
    }
    if (text) pieces.push(text);
    return pieces.map((text, part) => ({seq: message.seq, part, total: pieces.length, text}));
  }

  async function run(chat, signal, mode) {
    check(chat, signal);
    const controller = api();
    const state = getState(chat);
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Durable history state is required');
    const initial = state.initialComplete !== true;
    if (mode === 'recent' && !initial) return result(state, 0, false);
    if (state.throughSeq === undefined) {
      const projection = await controller.projections({sessionId: chat.sessionId}, signal);
      check(chat, signal);
      if (projection?.kind !== 'sequenced' || !Number.isSafeInteger(projection.asOfSeq) || projection.asOfSeq < 0) {
        throw new Error('Cold sequenced history unavailable; session may require migration (no activation attempted)');
      }
      await save(chat, state, {throughSeq: projection.asOfSeq, hasMore: true,
        cutoff: now() - 60 * 60 * 1000, sentSeqs: [], sentParts: {}}, signal);
    }
    if (state.hasMore === false) return result(state, 0, initial);
    // older before a successful initial load still honors the initial window.
    const recent = initial;
    let beforeSeq = state.beforeSeq;
    let hasMore = true;
    const selected = [];
    const handled = new Set(state.sentSeqs ?? []);
    let stopped = false;
    let unknownBefore;
    while (hasMore && !stopped) {
      check(chat, signal);
      const request = {address: {kind: 'session', sessionId: chat.sessionId},
        throughSeq: state.throughSeq, maxMessages: 50};
      if (beforeSeq !== undefined && beforeSeq !== null) request.beforeSeq = beforeSeq;
      const page = await controller.page(request, signal);
      check(chat, signal);
      if (!Array.isArray(page?.records) || typeof page.hasMore !== 'boolean') throw new Error('Invalid native history page');
      const events = page.records.filter(record => record?.type === 'event').map(record => record.event);
      if (events.some(event => !Number.isSafeInteger(event?.seq) || event.seq < 0 ||
          event.seq > state.throughSeq || (beforeSeq != null && event.seq >= beforeSeq))) {
        throw new Error('Native history page made no backward progress');
      }
      events.sort((a, b) => b.seq - a.seq);
      if (new Set(events.map(event => event.seq)).size !== events.length) throw new Error('Duplicate native history sequence');
      if (!events.length && page.hasMore) throw new Error('Empty native history page with hasMore');
      hasMore = page.hasMore;
      for (let index = 0; index < events.length; index++) {
        const event = events[index];
        const message = transcript(event);
        if (message && recent && !Number.isFinite(message.time)) {
          // Ignore unknown dates in recent, but retain a reread boundary for
          // older. The successful-seq ledger filters already seeded neighbors.
          unknownBefore = Math.max(unknownBefore ?? 0, event.seq + 1);
          beforeSeq = event.seq;
          continue;
        }
        if (message && recent && message.time < state.cutoff) {
          // Exclusive boundary leaves this fetched cutoff record for older().
          beforeSeq = event.seq + 1;
          hasMore = true;
          stopped = true;
          break;
        }
        beforeSeq = event.seq;
        if (message && !handled.has(event.seq) && !isLiveDelivered(chat, event.seq)) selected.push(message);
        if (selected.length >= maxMessages) {
          hasMore = index < events.length - 1 || page.hasMore;
          stopped = true;
          break;
        }
      }
    }
    if (unknownBefore !== undefined) {
      beforeSeq = Math.max(beforeSeq ?? 0, unknownBefore);
      hasMore = true;
    }
    selected.sort((a, b) => a.seq - b.seq);
    let sent = 0;
    let batch = [], length = 0;
    async function flush() {
      if (!batch.length) return;
      check(chat, signal);
      // Live mirroring may have completed during page reads / previous sends.
      const eligible = batch.filter(unit => !isLiveDelivered(chat, unit.seq));
      if (eligible.length) {
        await send(chat, eligible.map(unit => unit.text).join('\n\n'));
        check(chat, signal);
        const seqs = new Set(state.sentSeqs ?? []);
        const parts = {...state.sentParts};
        for (const unit of eligible) {
          if (unit.part === unit.total - 1) {
            if (!seqs.has(unit.seq)) sent++;
            seqs.add(unit.seq);
            delete parts[unit.seq];
          } else parts[unit.seq] = unit.part + 1;
        }
        await save(chat, state, {sentSeqs: [...seqs].sort((a, b) => a - b), sentParts: parts}, signal);
      }
      batch = []; length = 0;
    }
    for (const message of selected) {
      for (const unit of fragments(message).slice(state.sentParts?.[message.seq] ?? 0)) {
        if (length + unit.text.length + (batch.length ? 2 : 0) > 3500) await flush();
        length += unit.text.length + (batch.length ? 2 : 0);
        batch.push(unit);
      }
      // One DSH message per Telegram message; only oversized messages split.
      await flush();
    }
    await flush();
    await save(chat, state, {beforeSeq: beforeSeq ?? null, hasMore, initialComplete: true}, signal);
    return result(state, sent, initial);
  }
  function enqueue(chat, signal, mode) {
    // Snapshot caller routing so mutation cannot redirect an in-flight operation.
    chat = {chatId: chat.chatId, threadId: chat.threadId, sessionId: chat.sessionId,
      ...(chat.generation === undefined ? {} : {generation: chat.generation})};
    const id = key(chat);
    const promise = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(() => run(chat, signal, mode));
    queues.set(id, promise);
    const cleanup = () => { if (queues.get(id) === promise) queues.delete(id); };
    promise.then(cleanup, cleanup);
    return promise;
  }
  return {recent: (chat, signal) => enqueue(chat, signal, 'recent'),
    older: (chat, signal) => enqueue(chat, signal, 'older'),
    idle: () => Promise.allSettled([...queues.values()]).then(() => {})};
}
