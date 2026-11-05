/**
 * Mirror one native interaction without ever aborting its caller's signal.
 * Cordis next() takes no replacement request: it captures `request` itself.
 * Telegram must honor the clone's signal, including MIRROR_SETTLED close reasons.
 */
export function mirrorInteraction({request, next, telegram, kind}) {
  const invoke = fn => {
    try { return Promise.resolve(fn()); }
    catch (error) { return Promise.reject(error); }
  };
  const originalSignal = request.signal;
  const webAbort = new AbortController();
  const tgAbort = new AbortController();
  const combine = signal => AbortSignal.any(originalSignal ? [originalSignal, signal] : [signal]);
  const webSignal = combine(webAbort.signal);
  const tgSignal = combine(tgAbort.signal);
  const hadSignal = Object.hasOwn(request, 'signal');
  try {
    request.signal = webSignal;
    if (request.signal !== webSignal) return invoke(next);
  } catch {
    // Frozen native requests cannot be safely mirrored through Cordis.
    return invoke(next);
  }

  const restore = () => {
    // Do not overwrite another middleware's replacement signal.
    try {
      if (request.signal !== webSignal) return;
      if (hadSignal) request.signal = originalSignal;
      else delete request.signal;
    } catch { /* The request may have been frozen after dispatch. */ }
  };
  const tgRequest = {...request, signal: tgSignal};
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = {web: false, telegram: false};
    const failures = {};
    const cleanup = () => originalSignal?.removeEventListener('abort', onAbort);
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(value);
      else resolve(value);
    };
    const onAbort = () => {
      if (settled) return;
      const reason = originalSignal.reason;
      webAbort.abort(reason);
      tgAbort.abort(reason);
      if (kind === 'approval') finish('cancelled', false);
      else finish(reason, true);
    };
    const valid = value => kind === 'approval'
      ? ['allowed-once', 'rejected', 'cancelled'].includes(value)
      : value !== null && typeof value === 'object' && Array.isArray(value.answers);
    const observe = (channel, value, error = false) => {
      if (channel === 'web') restore();
      done[channel] = true;
      if (settled) return;
      if (!error && valid(value)) {
        // Mark settled before abort listeners can cause any reentrant activity.
        finish(value, false);
        const loser = channel === 'web' ? tgAbort : webAbort;
        loser.abort({code: 'MIRROR_SETTLED', channel});
      } else {
        if (error) failures[channel] = value;
        if (done.web && done.telegram) {
          if (kind === 'approval') finish('unavailable', false);
          else finish(
            failures.web instanceof Error ? failures.web
              : failures.telegram instanceof Error ? failures.telegram
                : new Error('No interaction provider returned an answer'),
            true,
          );
        }
      }
    };

    originalSignal?.addEventListener('abort', onAbort, {once: true});
    if (originalSignal?.aborted) {
      onAbort();
      restore();
      return;
    }
    // Invoke both now, not sequentially and not via a replacement argument to next.
    // Attach rejection observers even if the other branch already won or aborted.
    invoke(next).then(value => observe('web', value), error => observe('web', error, true));
    invoke(() => telegram(tgRequest)).then(
      value => observe('telegram', value), error => observe('telegram', error, true),
    );
  });
}
