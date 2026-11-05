import test from 'node:test';
import assert from 'node:assert/strict';
import {getEventListeners} from 'node:events';
import {mirrorInteraction} from './mirrored-interaction.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const answer = {answers: [{id: 'choice', value: 'one'}]};
function fixture(kind = 'approval', options = {}) {
  const original = new AbortController();
  const request = {signal: original.signal, prompt: 'Synthetic interaction'};
  const web = deferred(), tg = deferred(), calls = [];
  let webSignal, tgRequest;
  const promise = mirrorInteraction({request, kind,
    next: function () {
      assert.equal(arguments.length, 0);
      webSignal = request.signal;
      calls.push('web');
      if (options.webThrow) throw options.webThrow;
      return web.promise;
    },
    telegram: clone => {
      tgRequest = clone;
      calls.push('telegram');
      if (options.tgThrow) throw options.tgThrow;
      return tg.promise;
    },
  });
  return {original, request, web, tg, calls, promise,
    get webSignal() { return webSignal; }, get tgRequest() { return tgRequest; }};
}

for (const kind of ['approval', 'question']) {
  test(`${kind}: both render immediately; Web winner closes Telegram only`, async () => {
    const f = fixture(kind);
    assert.deepEqual(f.calls, ['web', 'telegram']);
    assert.notEqual(f.tgRequest, f.request);
    assert.notEqual(f.webSignal, f.original.signal);
    assert.notEqual(f.tgRequest.signal, f.webSignal);
    assert.equal(f.request.signal, f.webSignal);
    assert.equal(f.tgRequest.prompt, f.request.prompt);
    const value = kind === 'approval' ? 'allowed-once' : answer;
    f.web.resolve(value);
    assert.equal(await f.promise, value);
    assert.equal(f.request.signal, f.original.signal);
    assert.equal(f.webSignal.aborted, false);
    assert.equal(f.original.signal.aborted, false);
    assert.deepEqual(f.tgRequest.signal.reason, {code: 'MIRROR_SETTLED', channel: 'web'});
    assert.equal(getEventListeners(f.original.signal, 'abort').length, 0);
    f.tg.reject(new Error('Late Telegram disposal'));
    await tick();
    assert.equal(await f.promise, value);
  });

  test(`${kind}: Telegram winner closes Web; queued bridge still sees combined signal`, async () => {
    const f = fixture(kind);
    const value = kind === 'approval' ? 'rejected' : answer;
    f.tg.resolve(value);
    assert.equal(await f.promise, value);
    // Native gateway may not read the mutable request until after Telegram wins.
    assert.equal(f.request.signal, f.webSignal);
    assert.deepEqual(f.request.signal.reason, {code: 'MIRROR_SETTLED', channel: 'telegram'});
    assert.equal(f.tgRequest.signal.aborted, false);
    assert.equal(f.original.signal.aborted, false);
    assert.equal(getEventListeners(f.original.signal, 'abort').length, 0);
    f.web.reject(new Error('Late Web cancellation'));
    await tick();
    assert.equal(f.request.signal, f.original.signal);
    assert.equal(await f.promise, value);
  });

  test(`${kind}: Telegram off/disposed does not cancel pending Web`, async () => {
    const f = fixture(kind);
    if (kind === 'approval') f.tg.resolve('unavailable');
    else f.tg.reject(new Error('Telegram disposed'));
    await tick();
    assert.equal(f.webSignal.aborted, false);
    const value = kind === 'approval' ? 'allowed-once' : answer;
    f.web.resolve(value);
    assert.equal(await f.promise, value);
  });

  test(`${kind}: missing Web provider leaves Telegram available`, async () => {
    const f = fixture(kind);
    f.web.reject(new Error('No Web provider'));
    await tick();
    assert.equal(f.tgRequest.signal.aborted, false);
    assert.equal(f.request.signal, f.original.signal);
    const value = kind === 'approval' ? 'allowed-once' : answer;
    f.tg.resolve(value);
    assert.equal(await f.promise, value);
    assert.equal(f.original.signal.aborted, false);
  });

  test(`${kind}: original abort cancels both and consumes late failures`, async () => {
    const f = fixture(kind);
    const reason = new Error('Caller stopped');
    f.original.abort(reason);
    if (kind === 'approval') assert.equal(await f.promise, 'cancelled');
    else await assert.rejects(f.promise, error => error === reason);
    assert.equal(f.webSignal.reason, reason);
    assert.equal(f.tgRequest.signal.reason, reason);
    // Keep the Web signal installed until that branch actually settles.
    assert.equal(f.request.signal, f.webSignal);
    assert.equal(getEventListeners(f.original.signal, 'abort').length, 0);
    f.web.reject(reason);
    f.tg.reject(reason);
    await tick();
    assert.equal(f.request.signal, f.original.signal);
  });

  test(`${kind}: late valid reply cannot replace winner`, async () => {
    const f = fixture(kind);
    const first = kind === 'approval' ? 'allowed-once' : answer;
    const second = kind === 'approval' ? 'rejected' : {answers: []};
    f.web.resolve(first);
    assert.equal(await f.promise, first);
    f.tg.resolve(second);
    await tick();
    assert.equal(await f.promise, first);
    assert.equal(f.original.signal.aborted, false);
  });

  test(`${kind}: synchronous Web throw does not prevent Telegram start`, async () => {
    const f = fixture(kind, {webThrow: new Error('No Web')});
    assert.deepEqual(f.calls, ['web', 'telegram']);
    const value = kind === 'approval' ? 'allowed-once' : answer;
    f.tg.resolve(value);
    assert.equal(await f.promise, value);
  });

  test(`${kind}: synchronous Telegram throw leaves Web usable`, async () => {
    const f = fixture(kind, {tgThrow: new Error('No Telegram')});
    const value = kind === 'approval' ? 'cancelled' : answer;
    f.web.resolve(value);
    assert.equal(await f.promise, value);
  });
}

test('approval: both fail returns unavailable regardless of settlement order', async () => {
  for (const reverse of [false, true]) {
    const f = fixture();
    if (reverse) {
      f.tg.reject(new Error('Telegram failed'));
      await tick();
      f.web.resolve('unavailable');
    } else {
      f.web.reject(new Error('Web failed'));
      await tick();
      f.tg.resolve('unavailable');
    }
    assert.equal(await f.promise, 'unavailable');
    assert.equal(f.original.signal.aborted, false);
  }
});

test('question: both fail rejects deterministic real Web error in either order', async () => {
  for (const reverse of [false, true]) {
    const f = fixture('question');
    const webError = new Error('No Web provider');
    const rejected = assert.rejects(f.promise, error => error === webError);
    if (reverse) {
      f.tg.reject(new Error('No Telegram provider'));
      await tick();
      f.web.reject(webError);
    } else {
      f.web.reject(webError);
      await tick();
      f.tg.reject(new Error('No Telegram provider'));
    }
    await rejected;
  }
});

test('question: invalid values cannot win, and both invalid rejects an Error', async () => {
  const f = fixture('question');
  const rejected = assert.rejects(f.promise, Error);
  f.web.resolve({answers: 'not an array'});
  await tick();
  assert.equal(f.tgRequest.signal.aborted, false);
  f.tg.resolve(undefined);
  await rejected;
});

test('question: use real Telegram error when Web failure is not an Error', async () => {
  const f = fixture('question');
  const error = new Error('Telegram failed');
  const rejected = assert.rejects(f.promise, value => value === error);
  f.web.reject('No provider');
  f.tg.reject(error);
  await rejected;
});

test('both synchronous throws are observed', async () => {
  const f = fixture('approval', {webThrow: new Error('Web'), tgThrow: new Error('Telegram')});
  assert.equal(await f.promise, 'unavailable');
});

test('frozen request delegates Web only, including synchronous throw', async () => {
  for (const throws of [false, true]) {
    const original = new AbortController();
    const request = Object.freeze({signal: original.signal});
    let webCalls = 0, tgCalls = 0;
    const error = new Error('Native failed');
    const promise = mirrorInteraction({request, kind: 'approval',
      next: () => { webCalls++; if (throws) throw error; return 'allowed-once'; },
      telegram: () => { tgCalls++; return 'rejected'; },
    });
    if (throws) await assert.rejects(promise, value => value === error);
    else assert.equal(await promise, 'allowed-once');
    assert.equal(webCalls, 1);
    assert.equal(tgCalls, 0);
    assert.equal(request.signal, original.signal);
  }
});

test('without original signal, restore missing property after Web completes', async () => {
  const request = {};
  let tgSignal;
  assert.equal(await mirrorInteraction({request, kind: 'approval',
    next: () => 'allowed-once', telegram: clone => { tgSignal = clone.signal; return 'unavailable'; },
  }), 'allowed-once');
  assert.equal(Object.hasOwn(request, 'signal'), false);
  assert.equal(tgSignal.aborted, true);
});

test('restoration does not overwrite another middleware signal', async () => {
  const f = fixture();
  const replacement = new AbortController().signal;
  f.request.signal = replacement;
  f.web.resolve('allowed-once');
  assert.equal(await f.promise, 'allowed-once');
  assert.equal(f.request.signal, replacement);
  f.tg.resolve('unavailable');
});

test('Web unavailable cannot beat a pending Telegram approval', async () => {
  const f = fixture();
  f.web.resolve('unavailable');
  await tick();
  assert.equal(f.tgRequest.signal.aborted, false);
  f.tg.resolve('allowed-once');
  assert.equal(await f.promise, 'allowed-once');
});

test('same-turn replies settle once, and subsequent caller abort cannot change outcome', async () => {
  const f = fixture();
  f.tg.resolve('rejected');
  f.web.resolve('allowed-once');
  assert.equal(await f.promise, 'rejected');
  f.original.abort(new Error('Later caller cancellation'));
  assert.equal(await f.promise, 'rejected');
  assert.equal(f.request.signal, f.original.signal);
  assert.deepEqual(f.webSignal.reason, {code: 'MIRROR_SETTLED', channel: 'telegram'});
});

test('pre-aborted original starts neither channel and preserves exact question reason', async () => {
  for (const kind of ['approval', 'question']) {
    const original = new AbortController();
    const reason = {code: 'CALLER_STOPPED'};
    original.abort(reason);
    const request = {signal: original.signal};
    let calls = 0;
    const promise = mirrorInteraction({request, kind,
      next: () => { calls++; }, telegram: () => { calls++; },
    });
    if (kind === 'approval') assert.equal(await promise, 'cancelled');
    else await assert.rejects(promise, value => value === reason);
    assert.equal(calls, 0);
    assert.equal(request.signal, original.signal);
    assert.equal(getEventListeners(original.signal, 'abort').length, 0);
  }
});
