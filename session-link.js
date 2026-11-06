import {isKnownTelegramRejection} from './topic-recovery.js';

/** Use the native Web client's dshSession handler, never an invented route. */
export function buildSessionLink(baseUrl, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || /\s|\p{Cc}/u.test(sessionId)) {
    throw new TypeError('Invalid session identity');
  }
  if (typeof baseUrl !== 'string' || baseUrl !== baseUrl.trim() || /[?#\p{Cc}]/u.test(baseUrl)) {
    throw new TypeError('Web base URL must not contain search, fragment or control characters');
  }
  let url;
  try { url = new URL(baseUrl); }
  catch { throw new TypeError('Invalid Web base URL'); }
  if (!/^https?:\/\//i.test(baseUrl) || /^https?:\/\/[^/]*@/i.test(baseUrl) ||
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) {
    throw new TypeError('Web base URL must be HTTP(S) without credentials');
  }
  url.searchParams.set('dshSession', sessionId);
  return url.href;
}

/**
 * getBinding(chatId, sessionId) must return the SAME canonical record object.
 * isAllowed(record) and getBaseUrl(record) are synchronous, reread admission.
 * call(method, payload, signal) is the real Bot API; persist() saves mutated state.
 * sessionLinkPin = {url, messageId, threadId, pinned}; false reuses the sent ID.
 * sessionLinkPending = {url, threadId} is a durable, manual-recovery-only send
 * latch. Persisted BEFORE send: a crash cannot silently duplicate a link.
 * Reconcile Telegram manually before clearing a pending latch. A confirmed 4xx
 * clears it automatically. Failed persistence remains fail-closed in memory.
 * ensure resolves true for confirmed pin, false when admission/signal changes;
 * network/persistence/validation errors reject. It never aborts caller signals.
 * A completed send is recorded even on revocation, but never followed by pin.
 */
export function createSessionLinkPins({getBinding, isAllowed, getBaseUrl, call, persist}) {
  const queues = new Map();
  function ensure(record, signal) {
    const identity = {chatId: record?.chatId, threadId: record?.threadId, sessionId: record?.sessionId};
    if (!Number.isSafeInteger(identity.chatId) || !Number.isSafeInteger(identity.threadId) || identity.threadId <= 0) {
      return Promise.reject(new TypeError('Invalid topic binding'));
    }
    const key = JSON.stringify([identity.chatId, identity.sessionId]);
    const current = () => !signal?.aborted && record.chatId === identity.chatId &&
      record.threadId === identity.threadId && record.sessionId === identity.sessionId &&
      getBinding(identity.chatId, identity.sessionId) === record && isAllowed(record) === true;
    const work = async () => {
      if (!current()) return false;
      const url = buildSessionLink(getBaseUrl(record), identity.sessionId);
      if (record.sessionLinkPending) {
        throw new Error('Session link send outcome is unknown; manual recovery required');
      }
      let pin = record.sessionLinkPin;
      const matches = pin?.url === url && pin.threadId === identity.threadId &&
        Number.isSafeInteger(pin.messageId) && pin.messageId > 0;
      if (matches && pin.pinned === true) return true;
      if (!matches) {
        record.sessionLinkPending = {url, threadId: identity.threadId};
        await persist();
        if (!current()) {
          // No send was dispatched; unlike a network failure this is safe to clear.
          delete record.sessionLinkPending;
          await persist();
          return false;
        }
        let result;
        try {
          result = await call('sendMessage', {
            chat_id: identity.chatId, message_thread_id: identity.threadId,
            text: `Открыть исходную сессию DSH:\n${url}`, disable_web_page_preview: true,
          }, signal);
        } catch (error) {
          if (isKnownTelegramRejection(error)) {
            delete record.sessionLinkPending;
            await persist();
          }
          throw error;
        }
        // A malformed success is uncertain too: do NOT guess the sent identity.
        if (!Number.isSafeInteger(result?.message_id) || result.message_id <= 0) {
          throw new Error('Session link send returned no valid message identity; manual recovery required');
        }
        pin = {url, messageId: result.message_id, threadId: identity.threadId, pinned: false};
        record.sessionLinkPin = pin;
        delete record.sessionLinkPending;
        await persist();
        if (!current()) return false;
      }
      // Retry a failed identity save before pinning, including within this process.
      if (!current()) return false;
      await persist();
      if (!current()) return false;
      await call('pinChatMessage', {
        chat_id: identity.chatId, message_id: pin.messageId, disable_notification: true,
      }, signal);
      if (!current()) return false;
      pin.pinned = true;
      try { await persist(); }
      catch (error) { pin.pinned = false; throw error; }
      return current();
    };
    const result = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, result);
    const clear = () => { if (queues.get(key) === result) queues.delete(key); };
    result.then(clear, clear);
    return result;
  }
  return {ensure};
}
