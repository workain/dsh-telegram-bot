import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSessionLink, createSessionLinkPins} from './session-link.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const binding = (chatId = -101, threadId = 7) => ({chatId, threadId, sessionId: 'synthetic-session'});
function fixture(options = {}) {
  const record = options.record ?? binding();
  const f = {record, allowed: true, baseUrl: 'https://web.example.test/workbench/', calls: [], saves: [], current: record};
  f.create = () => createSessionLinkPins({
    getBinding: (chatId, sessionId) => f.current?.chatId === chatId && f.current?.sessionId === sessionId ? f.current : null,
    isAllowed: () => f.allowed,
    getBaseUrl: () => f.baseUrl,
    persist: async () => {
      await options.persist?.(f);
      f.saves.push(structuredClone(record));
    },
    call: async (method, payload, signal) => {
      f.calls.push({method, payload, signal});
      return await options.call?.(method, payload, signal, f) ?? (method === 'sendMessage' ? {message_id: 201} : true);
    },
  });
  f.pins = f.create();
  return f;
}
const methods = f => f.calls.map(c => c.method);

test('link uses only the dshSession query with original opaque identity and path', () => {
  const id = 'session-synthetic/opaque?value=#plus+';
  const link = new URL(buildSessionLink('https://web.example.test/dsh/app/', id));
  assert.equal(link.pathname, '/dsh/app/');
  assert.deepEqual([...link.searchParams], [['dshSession', id]]);
  assert.equal(link.hash, '');
  assert.equal(buildSessionLink('http://localhost:4321', 'synthetic'), 'http://localhost:4321/?dshSession=synthetic');
});

test('rejects auth/search/fragment/userinfo and malformed bases without leaking their content', () => {
  for (const base of [
    'https://web.example.test/?token=synthetic', 'https://web.example.test/#synthetic',
    'https://web.example.test/?', 'https://web.example.test/#',
    'https://synthetic:synthetic@web.example.test/', 'https://synthetic@web.example.test/',
    'https://@web.example.test/', 'http:web.example.test',
    'file:///tmp/synthetic', 'javascript:synthetic', '/relative', '', null,
    ' https://web.example.test/', 'https://web.example.test/\npath',
  ]) assert.throws(() => buildSessionLink(base, 'synthetic'), TypeError);
  for (const id of ['', ' ', ' synthetic', 'synthetic\n', 'a b', 'a\u0000b', null, 7]) {
    assert.throws(() => buildSessionLink('https://web.example.test/', id), TypeError);
  }
});

test('real Bot API payload, durable send identity before pin, concurrent calls and restart are idempotent', async () => {
  const signal = new AbortController().signal;
  const f = fixture({call: (method, _payload, actualSignal, f) => {
    assert.equal(actualSignal, signal);
    if (method === 'sendMessage') assert.ok(f.saves.at(-1).sessionLinkPending);
    if (method === 'pinChatMessage') {
      assert.equal(f.saves.at(-1).sessionLinkPin.messageId, 201);
      assert.equal(f.saves.at(-1).sessionLinkPin.pinned, false);
      assert.equal(f.saves.at(-1).sessionLinkPending, undefined);
    }
  }});
  assert.deepEqual(await Promise.all([f.pins.ensure(f.record, signal), f.pins.ensure(f.record, signal)]), [true, true]);
  assert.deepEqual(methods(f), ['sendMessage', 'pinChatMessage']);
  assert.deepEqual(f.calls[0].payload, {
    chat_id: -101, message_thread_id: 7,
    text: 'Открыть исходную сессию DSH:\nhttps://web.example.test/workbench/?dshSession=synthetic-session',
    disable_web_page_preview: true,
  });
  assert.deepEqual(f.calls[1].payload, {chat_id: -101, message_id: 201, disable_notification: true});
  assert.equal(await f.create().ensure(f.record, signal), true);
  assert.equal(f.calls.length, 2);
  assert.equal(signal.aborted, false);
});

test('same session in different chats is independently serialized', async () => {
  const a = binding(-101), b = binding(-102);
  const records = [a, b], calls = [], gate = deferred();
  const pins = createSessionLinkPins({
    getBinding: chatId => records.find(r => r.chatId === chatId), isAllowed: () => true,
    getBaseUrl: () => 'https://web.example.test/', persist: async () => {},
    call: async (method, data) => {
      calls.push([method, data.chat_id]);
      if (method === 'sendMessage' && data.chat_id === a.chatId) await gate.promise;
      return method === 'sendMessage' ? {message_id: 201} : true;
    },
  });
  const waiting = pins.ensure(a);
  await pins.ensure(b);
  assert.ok(calls.some(([method, chatId]) => method === 'pinChatMessage' && chatId === b.chatId));
  gate.resolve();
  await waiting;
});

test('missing pin rights and unknown pin failures retry the SAME message after restart', async () => {
  for (const error of [Object.assign(new Error('No pin rights'), {telegram: true, telegramCode: 400}), new Error('Lost response')]) {
    let fail = true;
    const f = fixture({call: method => { if (method === 'pinChatMessage' && fail) throw error; }});
    await assert.rejects(f.pins.ensure(f.record), error);
    assert.deepEqual(f.record.sessionLinkPin, {
      url: buildSessionLink(f.baseUrl, f.record.sessionId), messageId: 201, threadId: 7, pinned: false,
    });
    fail = false;
    await f.create().ensure(f.record);
    assert.deepEqual(methods(f), ['sendMessage', 'pinChatMessage', 'pinChatMessage']);
  }
});

test('new base URL sends and pins a new link without deleting or unpinning anything', async () => {
  const f = fixture();
  await f.pins.ensure(f.record);
  f.baseUrl = 'https://new-web.example.test/';
  await f.pins.ensure(f.record);
  assert.deepEqual(methods(f), ['sendMessage', 'pinChatMessage', 'sendMessage', 'pinChatMessage']);
  assert.equal(f.record.sessionLinkPin.url, buildSessionLink(f.baseUrl, f.record.sessionId));
});

test('unknown send failure latches durably across restart, no unsafe retry', async () => {
  const f = fixture({call: () => { throw new Error('Lost send response'); }});
  await assert.rejects(f.pins.ensure(f.record), /Lost send/);
  assert.ok(f.saves.at(-1).sessionLinkPending);
  await assert.rejects(f.pins.ensure(f.record), /manual recovery/);
  await assert.rejects(f.create().ensure(f.record), /manual recovery/);
  assert.deepEqual(methods(f), ['sendMessage']);
});

test('explicit Telegram 4xx rejection safely retries send, generic status is NOT trusted', async () => {
  let fail = true;
  const rejection = Object.assign(new Error('Rejected'), {telegram: true, telegramCode: 403});
  const f = fixture({call: method => { if (method === 'sendMessage' && fail) throw rejection; }});
  await assert.rejects(f.pins.ensure(f.record), rejection);
  assert.equal(f.record.sessionLinkPending, undefined);
  fail = false;
  await f.pins.ensure(f.record);
  assert.deepEqual(methods(f), ['sendMessage', 'sendMessage', 'pinChatMessage']);
  const unknown = fixture({call: () => { throw Object.assign(new Error('Proxy'), {status: 400}); }});
  await assert.rejects(unknown.pins.ensure(unknown.record));
  await assert.rejects(unknown.pins.ensure(unknown.record), /manual recovery/);
});

test('pre-aborted signal prevents work and caller controller is never aborted', async () => {
  const f = fixture(), controller = new AbortController();
  controller.abort();
  assert.equal(await f.pins.ensure(f.record, controller.signal), false);
  assert.equal(f.calls.length, 0);
  assert.equal(f.saves.length, 0);
});

for (const change of ['revoked', 'replacement', 'thread', 'session', 'chat', 'aborted']) {
  test(`${change} during send retains sent identity but never pins`, async () => {
    const entered = deferred(), gate = deferred(), controller = new AbortController();
    const f = fixture({call: async method => {
      if (method === 'sendMessage') { entered.resolve(); await gate.promise; }
    }});
    const running = f.pins.ensure(f.record, controller.signal);
    await entered.promise;
    if (change === 'revoked') f.allowed = false;
    if (change === 'replacement') f.current = {...f.record};
    if (change === 'thread') f.record.threadId++;
    if (change === 'session') f.record.sessionId = 'other-synthetic';
    if (change === 'chat') f.record.chatId--;
    if (change === 'aborted') controller.abort();
    gate.resolve();
    assert.equal(await running, false);
    assert.deepEqual(methods(f), ['sendMessage']);
    assert.equal(f.record.sessionLinkPin.messageId, 201);
    assert.equal(f.record.sessionLinkPin.pinned, false);
    assert.equal(f.record.sessionLinkPin.threadId, 7);
    assert.equal(f.saves.at(-1).sessionLinkPin.messageId, 201);
  });
}

test('revocation while initial latch is persisting dispatches nothing and clears safe latch', async () => {
  const f = fixture({persist: f => { f.allowed = false; }});
  assert.equal(await f.pins.ensure(f.record), false);
  assert.equal(f.record.sessionLinkPending, undefined);
  assert.equal(f.calls.length, 0);
});

test('revocation during pin does not confirm pin metadata', async () => {
  const f = fixture({call: (method, _payload, _signal, f) => {
    if (method === 'pinChatMessage') f.allowed = false;
  }});
  assert.equal(await f.pins.ensure(f.record), false);
  assert.equal(f.record.sessionLinkPin.pinned, false);
});

test('failed sent-identity persistence cannot trigger a duplicate send or undurable pin', async () => {
  let fail = true;
  const f = fixture({persist: f => {
    if (f.record.sessionLinkPin && fail) throw new Error('Storage unavailable');
  }});
  await assert.rejects(f.pins.ensure(f.record), /Storage/);
  await assert.rejects(f.pins.ensure(f.record), /Storage/);
  assert.deepEqual(methods(f), ['sendMessage']);
  fail = false;
  await f.pins.ensure(f.record);
  assert.deepEqual(methods(f), ['sendMessage', 'pinChatMessage']);
});

test('malformed successful send stays uncertain, and absent legacy confirmation safely re-pins', async () => {
  const f = fixture({call: () => ({})});
  await assert.rejects(f.pins.ensure(f.record), /manual recovery/);
  await assert.rejects(f.pins.ensure(f.record), /manual recovery/);
  assert.deepEqual(methods(f), ['sendMessage']);
  const legacy = fixture();
  legacy.record.sessionLinkPin = {url: buildSessionLink(legacy.baseUrl, legacy.record.sessionId), messageId: 201, threadId: 7};
  await legacy.pins.ensure(legacy.record);
  assert.deepEqual(methods(legacy), ['pinChatMessage']);
});
