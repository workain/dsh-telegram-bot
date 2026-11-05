import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionHistory} from './session-history.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const fakeAssignment = ['TO', 'KEN'].join('') + '=' + ['synthetic', 'placeholder'].join('-');
const chat = {chatId: 101, threadId: 7, sessionId: 'synthetic-session'};
const deferred = () => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return {promise, resolve};
};
const user = (seq, age, text = `human-${seq}`, extra = {}) => ({seq,
  time: new Date(NOW - age * 60000).toISOString(), type: 'user/message',
  data: {source: {kind: 'user'}, content: [{type: 'text', text}], ...extra}});
const assistant = (seq, age, text = `answer-${seq}`, blocks = []) => ({...user(seq, age),
  type: 'assistant/message', data: {message: {content: [{type: 'text', text}, ...blocks]}}});
function fixture(events = [], options = {}) {
  const state = options.state ?? {};
  const sent = [], requests = [], projections = [];
  let allowed = true, binding = {...chat}, saves = 0;
  const controller = {
    projections: async (request, signal) => {
      projections.push(request);
      if (options.projection) return options.projection(request, signal);
      return {kind: 'sequenced', asOfSeq: options.cut ?? Math.max(0, ...events.map(event => event.seq))};
    },
    page: async (request, signal) => {
      requests.push(request);
      if (options.page) return options.page(request, signal);
      const eligible = events.filter(event => event.seq <= request.throughSeq &&
        (request.beforeSeq == null || event.seq < request.beforeSeq)).sort((a, b) => b.seq - a.seq);
      const page = eligible.slice(0, options.pageSize ?? request.maxMessages);
      return {records: page.map(event => ({type: 'event', event})), hasMore: eligible.length > page.length};
    },
  };
  // Any accidental history follower or agent activation fails the test.
  for (const method of ['inspect', 'readSurface', 'history', 'resolveAgent', 'follow']) {
    controller[method] = () => { throw new Error(`Forbidden activation/read: ${method}`); };
  }
  const history = createSessionHistory({ctx: {sessionController: controller},
    getState: () => state, getBinding: () => binding, isAllowed: () => allowed,
    now: () => NOW, maxMessages: options.maxMessages ?? 200,
    isLiveDelivered: options.isLiveDelivered,
    send: async (target, text) => {
      assert.deepEqual(target, chat);
      if (options.send) await options.send(text);
      sent.push(text);
    },
    persist: async () => { saves++; await options.persist?.(state); },
  });
  return {history, state, sent, requests, projections, controller,
    revoke: () => { allowed = false; }, bind: value => { binding = value; },
    get saves() { return saves; }};
}
const text = f => f.sent.join('\n');

test('last hour inclusive, ascending pages, frozen baseline; older retains fetched cutoff', async () => {
  const events = [user(1, 120), assistant(2, 61), user(3, 60), assistant(4, 20), user(5, 0)];
  const f = fixture(events, {pageSize: 2});
  const first = await f.history.recent(chat);
  assert.deepEqual(first, {sent: 3, hasMore: true, beforeSeq: 3, throughSeq: 5, initial: true});
  assert.match(text(f), /2026-11-05T11:00:00.000Z/);
  assert.ok(text(f).indexOf('human-3') < text(f).indexOf('answer-4'));
  assert.ok(text(f).indexOf('answer-4') < text(f).indexOf('human-5'));
  assert.doesNotMatch(text(f), /human-1|answer-2/);
  events.push(assistant(6, 0, 'after-frozen-cut'));
  const older = await f.history.older(chat);
  assert.deepEqual(older, {sent: 2, hasMore: false, beforeSeq: 1, throughSeq: 5, initial: false});
  assert.ok(text(f).indexOf('human-1') < text(f).indexOf('answer-2'));
  assert.doesNotMatch(text(f), /after-frozen-cut/);
  assert.equal(f.projections.length, 1);
  assert.ok(f.requests.every(request => request.throughSeq === 5 && request.maxMessages === 50));
});

test('budget stops at earliest selected boundary; older loses no eligible records', async () => {
  const f = fixture(Array.from({length: 9}, (_, index) => user(index + 1, 1)), {maxMessages: 3, pageSize: 5});
  assert.equal((await f.history.recent(chat)).beforeSeq, 7);
  assert.equal((await f.history.older(chat)).beforeSeq, 4);
  assert.equal((await f.history.older(chat)).hasMore, false);
  assert.deepEqual(f.state.sentSeqs, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  for (let seq = 1; seq <= 9; seq++) assert.equal(text(f).split(`human-${seq}`).length - 1, 1);
});

test('only real human and assistant text; actual tool preamble allowed, arguments never', async () => {
  const events = [user(1, 1),
    user(2, 1, 'synthetic-input', {source: {kind: 'synthetic'}}),
    user(3, 1, 'goal-input', {source: {kind: 'goal'}}),
    user(4, 1, 'injected-input', {source: {kind: 'injected'}}),
    assistant(5, 1, 'I will check', [{type: 'tool-call', arguments: 'hidden-arguments'},
      {type: 'reasoning', text: 'hidden-reasoning'}]),
    ...['system/message', 'tool/result', 'tool/call', 'turn/end', 'error'].map((type, index) => ({
      seq: index + 6, time: NOW, type, data: {content: [{type: 'text', text: 'hidden-object'}]},
    }))];
  const f = fixture(events);
  assert.equal((await f.history.recent(chat)).sent, 2);
  assert.match(text(f), /human-1/);
  assert.match(text(f), /I will check/);
  assert.doesNotMatch(text(f), /synthetic-input|goal-input|injected-input|hidden-/);
});

test('repeat and restart are durable no-ops; live-delivered sequences are skipped', async () => {
  const events = [user(1, 90), user(2, 1), assistant(3, 1)];
  const f = fixture(events, {isLiveDelivered: (_chat, seq) => seq === 3});
  assert.equal((await f.history.recent(chat)).sent, 1);
  assert.equal((await f.history.recent(chat)).sent, 0);
  const g = fixture(events, {state: structuredClone(f.state)});
  assert.equal((await g.history.recent(chat)).sent, 0);
  assert.equal((await g.history.older(chat)).sent, 1);
  assert.equal((await g.history.older(chat)).sent, 0);
  assert.equal(g.projections.length, 0);
  assert.doesNotMatch(text(g), /human-2|answer-3/);
});

test('simultaneous recent calls serialize and do not duplicate', async () => {
  const gate = deferred();
  const f = fixture([user(1, 0)], {send: () => gate.promise});
  const a = f.history.recent(chat);
  const b = f.history.recent(chat);
  gate.resolve();
  assert.deepEqual((await Promise.all([a, b])).map(value => value.sent), [1, 0]);
  await f.history.idle();
  assert.equal(f.sent.length, 1);
});

test('one source message per Telegram message, size cap, chronological order and redaction', async () => {
  const f = fixture([user(1, 1, 'first'), assistant(2, 1, 'second'),
    user(3, 1, `${'😀'.repeat(17000)}\n${fakeAssignment}`)]);
  assert.equal((await f.history.recent(chat)).sent, 3);
  assert.ok(f.sent.every(value => value.length <= 3500));
  assert.match(f.sent[0], /first/);
  assert.doesNotMatch(f.sent[0], /second/);
  assert.match(f.sent[1], /second/);
  assert.doesNotMatch(f.sent[1], /first/);
  assert.equal(Array.from(text(f)).filter(point => point === '😀').length, 16000);
  assert.match(text(f), /Сокращено/);
  const g = fixture([user(1, 1, fakeAssignment)]);
  await g.history.recent(chat);
  assert.match(text(g), /REDACTED/);
  assert.doesNotMatch(text(g), /synthetic-placeholder/);
});

test('failed send never marks failed message and retry/restart resumes partial long text', async () => {
  let attempt = 0;
  const events = [user(1, 1, 'x'.repeat(8000))];
  const f = fixture(events, {send: () => { if (++attempt === 2) throw new Error('synthetic send failure'); }});
  await assert.rejects(f.history.recent(chat), /synthetic send failure/);
  assert.deepEqual(f.state.sentSeqs, []);
  assert.equal(f.state.sentParts[1], 1);
  const g = fixture(events, {state: structuredClone(f.state)});
  assert.equal((await g.history.recent(chat)).sent, 1);
  assert.equal(text(f).replace(/[^x]/g, '').length + text(g).replace(/[^x]/g, '').length, 8000);
  assert.deepEqual(g.state.sentParts, {});
});

test('revocation after projection/page and binding changes prevent all sends', async () => {
  for (const stage of ['projection', 'page']) {
    const gate = deferred(), entered = deferred();
    const options = {[stage]: async () => {
      entered.resolve(); await gate.promise;
      return stage === 'projection' ? {kind: 'sequenced', asOfSeq: 1}
        : {records: [{type: 'event', event: user(1, 1)}], hasMore: false};
    }};
    const f = fixture([user(1, 1)], options);
    const work = f.history.recent(chat);
    await entered.promise;
    if (stage === 'projection') f.revoke();
    else f.bind({...chat, sessionId: 'replacement'});
    gate.resolve();
    await assert.rejects(work, /revoked|binding changed/);
    assert.deepEqual(f.sent, []);
  }
});

test('recheck after send stops following chunks and does not advance cursor', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture([user(1, 1, 'x'.repeat(8000))], {send: async () => { entered.resolve(); await gate.promise; }});
  const work = f.history.recent(chat);
  await entered.promise;
  f.bind({...chat, threadId: 99});
  gate.resolve();
  await assert.rejects(work, /binding changed/);
  assert.equal(f.sent.length, 1);
  assert.equal(f.state.beforeSeq, undefined);
  assert.deepEqual(f.state.sentSeqs, []);
});

test('unknown time is not rendered as recent but is available to older', async () => {
  const f = fixture([user(1, 1), {...user(2, 1), time: 'not-a-date'}, user(3, 0)]);
  assert.equal((await f.history.recent(chat)).sent, 2);
  assert.equal((await f.history.older(chat)).sent, 1);
  assert.equal(text(f).split('human-1').length - 1, 1);
  assert.match(text(f), /дата неизвестна/);
});

test('native missing, unavailable/migration and progress errors propagate without fallback', async () => {
  const missing = fixture();
  delete missing.controller.page;
  await assert.rejects(missing.history.recent(chat), /native.*API is required/);
  for (const projection of [null, {kind: 'migration-required'}]) {
    const f = fixture([], {projection: async () => projection});
    await assert.rejects(f.history.recent(chat), /migration/);
    assert.equal(f.requests.length, 0);
  }
  const rejected = fixture([], {projection: async () => { throw new Error('migration-required'); }});
  await assert.rejects(rejected.history.recent(chat), /migration-required/);
  const empty = fixture([], {page: async () => ({records: [], hasMore: true})});
  await assert.rejects(empty.history.recent(chat), /Empty native/);
  let calls = 0;
  const stuck = fixture([], {cut: 2, page: async () => {
    calls++; return {records: [{type: 'event', event: user(2, 1)}], hasMore: true};
  }});
  await assert.rejects(stuck.history.recent(chat), /no backward progress/);
  assert.equal(calls, 2);
});

test('aborted requests do not read or send; empty session is successful', async () => {
  const abort = new AbortController(); abort.abort(new Error('synthetic cancellation'));
  const f = fixture([]);
  await assert.rejects(f.history.recent(chat, abort.signal), /synthetic cancellation/);
  assert.equal(f.projections.length, 0);
  assert.deepEqual(await f.history.recent(chat), {sent: 0, hasMore: false,
    beforeSeq: null, throughSeq: 0, initial: true});
});
