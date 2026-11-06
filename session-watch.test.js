import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionWatch} from './session-watch.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
const root = id => ({id, header: {id}});
const event = (type, seq, turn = 1, extra = {}) => ({type, seq, data: {turn, ...extra}});
const answer = (seq, turn, text, extra = []) => event('assistant/message', seq, turn, {
  message: {role: 'assistant', content: [{type: 'text', text}, ...extra]},
});
function fixture(options = {}) {
  const state = options.state ?? {};
  const sent = [], created = [], errors = [], listeners = new Set();
  let saves = 0, lists = 0;
  const policy = {enabled: true, allowed: true, chatId: 101, workspaceIds: ['project-a']};
  const registry = {archivedSessionIds: [], list: () => [
    {id: 'project-a', sessionIds: ['one', 'two', 'child', 'archived', 'blank', 'idle']},
    {id: 'project-b', sessionIds: ['other']},
  ]};
  const ctx = {
    workspaceRegistry: registry,
    sessionController: {list: async (_request, signal) => {
      lists++;
      assert.ok(signal instanceof AbortSignal);
      return {items: options.items ?? []};
    }},
    on: (name, fn, options) => {
      assert.equal(name, 'session/event');
      assert.equal(options?.global, true, 'Host observer must receive scoped Session events');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const watch = createSessionWatch({ctx, getState: () => state, getPolicy: () => policy,
    ensureTopic: async (id, chatId) => {
      created.push(id);
      if (options.topic) await options.topic(id);
      return {chatId, threadId: 7, sessionId: id};
    },
    send: async (chat, text) => {
      if (options.send) await options.send(chat, text);
      sent.push({chat, text});
    },
    persist: async () => { saves++; if (options.persist) await options.persist(state); },
    onError: (error, context) => { errors.push({error, context}); return options.onError?.(); },
  });
  return {watch, ctx, state, policy, registry, sent, created, errors, listeners,
    get saves() { return saves; }, get lists() { return lists; },
    emit: (session, e) => [...listeners].map(fn => fn(session, e)),
  };
}

test('Host services resolve through ctx.get without undeclared Cordis property injection', async () => {
  const f = fixture({items: [{sessionId: 'one', running: true, blank: false}]});
  const services = {workspaceRegistry: f.ctx.workspaceRegistry, sessionController: f.ctx.sessionController};
  f.ctx.get = name => services[name];
  for (const name of Object.keys(services)) Object.defineProperty(f.ctx, name, {
    get() { throw new Error('Cannot access sibling service without inject'); },
  });
  f.policy.mirrorMessages = true;
  await f.watch.start();
  f.emit(root('one'), event('turn/start', 1));
  f.emit(root('one'), answer(2, 1, 'Actual committed work message'));
  f.emit(root('one'), event('turn/end', 3, 1, {reason: {kind: 'completed'}}));
  await f.watch.idle();
  assert.equal(f.errors.length, 0);
  assert.deepEqual(f.created, ['one']);
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[0].text, /Actual committed work message/);
  assert.match(f.sent[1].text, /completed/);
  assert.equal(f.state.sessions.one.cursor, 3);
  await f.watch.dispose();
});

test('startup discovers only running nonblank selected root sessions; no history', async () => {
  const f = fixture({items: [
    {sessionId: 'one', running: true, blank: false},
    {sessionId: 'idle', running: false, blank: false},
    {sessionId: 'blank', running: true, blank: true},
    {sessionId: 'other', running: true, blank: false},
    {sessionId: 'child', running: true, blank: false, origin: 'subagent'},
    {sessionId: 'archived', running: true, blank: false},
  ]});
  f.registry.archivedSessionIds.push('archived');
  await f.watch.start();
  await f.watch.start();
  await f.watch.idle();
  assert.deepEqual(f.created, ['one']);
  assert.equal(f.sent.length, 0);
  assert.equal(f.lists, 1);
  await f.watch.reconcile();
  await f.watch.idle();
  assert.deepEqual(f.created, ['one']);
  await f.watch.dispose();
});

test('new web session and queued turns keep their own final text and reason', async () => {
  const gate = deferred();
  const f = fixture({topic: () => gate.promise});
  await f.watch.start();
  const s = root('one');
  assert.deepEqual(f.emit(s, event('turn/start', 10)), [undefined]);
  f.emit(s, answer(11, 1, 'First answer'));
  f.emit(s, event('turn/end', 12, 1, {reason: {kind: 'completed'}}));
  f.emit(s, event('turn/start', 13, 2));
  f.emit(s, answer(14, 2, 'Second answer'));
  f.emit(s, event('turn/end', 15, 2, {reason: {kind: 'blocked'}}));
  gate.resolve();
  await f.watch.idle();
  assert.deepEqual(f.created, ['one']);
  assert.deepEqual(f.sent.map(x => x.text), [
    'First answer\n\nTurn 1: completed', 'Second answer\n\nTurn 2: blocked',
  ]);
  assert.equal(f.state.sessions.one.cursor, 15);
  assert.deepEqual(f.state.sessions.one.turns, {});
  await f.watch.dispose();
});

test('only tool name and committed assistant text; never raw content/errors', async () => {
  const f = fixture();
  await f.watch.start();
  const s = root('one');
  f.emit(s, event('turn/start', 0));
  f.emit(s, event('user/message', 1, 1, {content: [{type: 'text', text: 'PRIVATE USER'}]}));
  f.emit(s, answer(2, 1, 'PRIVATE PREAMBLE', [
    {type: 'tool-call', name: 'read', arguments: 'PRIVATE ARGUMENTS'},
  ]));
  f.emit(s, event('tool/call', 3, 1, {name: 'read', arguments: 'PRIVATE ARGUMENTS'}));
  f.emit(s, event('tool/result', 4, 1, {message: {content: 'PRIVATE RESULT'}}));
  f.emit(s, answer(5, 1, 'Public answer', [{type: 'reasoning', text: 'PRIVATE REASONING'}]));
  f.emit(s, event('turn/end', 6, 1, {reason: {kind: 'error', error: {message: 'PRIVATE ERROR'}}}));
  await f.watch.idle();
  assert.deepEqual(f.sent.map(x => x.text), ['Tool: read', 'Public answer\n\nTurn 1: error']);
  assert.ok(!JSON.stringify(f.state).includes('PRIVATE'));
  await f.watch.dispose();
});

test('tool request preamble is not a final answer when no answer follows', async () => {
  const f = fixture();
  await f.watch.start();
  f.emit(root('one'), answer(3, 1, 'Will run a tool', [{type: 'tool-call', name: 'run'}]));
  f.emit(root('one'), event('turn/end', 4, 1, {reason: {kind: 'error'}}));
  await f.watch.idle();
  assert.deepEqual(f.sent.map(x => x.text), ['Turn 1: error']);
  await f.watch.dispose();
});

test('durable seq dedup across restart, including a partially observed turn', async () => {
  const f = fixture();
  await f.watch.start();
  const s = root('one');
  const start = event('turn/start', 20);
  const text = answer(21, 1, 'Stored answer');
  const end = event('turn/end', 22, 1, {reason: {kind: 'completed'}});
  f.emit(s, start); f.emit(s, text);
  await f.watch.idle();
  await f.watch.dispose();
  const g = fixture({state: structuredClone(f.state)});
  await g.watch.start();
  g.emit(s, start); g.emit(s, text); g.emit(s, end); g.emit(s, end);
  await g.watch.idle();
  assert.equal(g.created.length, 0);
  assert.deepEqual(g.sent.map(x => x.text), ['Stored answer\n\nTurn 1: completed']);
  await g.watch.dispose();
  const h = fixture({state: structuredClone(g.state)});
  await h.watch.start();
  h.emit(s, end);
  await h.watch.idle();
  assert.equal(h.sent.length, 0);
  await h.watch.dispose();
});

test('archive, subagent ownership, membership and explicit manual selection gates', async () => {
  const f = fixture();
  f.registry.archivedSessionIds.push('archived');
  f.policy.boundSessionIds = ['other', 'orphan'];
  await f.watch.start();
  for (const s of [root('archived'), root('orphan'),
    {id: 'child', header: {origin: 'subagent', parentSession: 'one', isSeeded: true}},
    {id: 'child', header: {delegationDepth: 1}},
  ]) f.emit(s, event('turn/start', 0));
  f.emit(root('other'), event('turn/start', 0));
  await f.watch.idle();
  assert.deepEqual(f.created, ['other']);
  await f.watch.dispose();
});

test('ordinary user fork summary and live seeded header remain eligible, subagents do not', async () => {
  const f = fixture({items: [
    {sessionId: 'one', running: true, blank: false, parentSessionId: 'seed-source'},
    {sessionId: 'child', running: true, blank: false, parentSessionId: 'seed-source', origin: 'subagent'},
  ]});
  await f.watch.start();
  await f.watch.idle();
  assert.deepEqual(f.created, ['one']);
  const fork = {id: 'one', header: {parentSession: 'seed-source', isSeeded: true}};
  f.emit(fork, event('turn/start', 20));
  f.emit(fork, event('tool/call', 21, 1, {name: 'read'}));
  f.emit(fork, answer(22, 1, 'Fork answer'));
  f.emit(fork, event('turn/end', 23, 1, {reason: {kind: 'completed'}}));
  const child = {id: 'child', header: {
    parentSession: 'seed-source', isSeeded: true, origin: 'subagent',
  }};
  f.emit(child, event('turn/start', 20));
  f.emit(child, answer(21, 1, 'Must not leave'));
  f.emit(child, event('turn/end', 22, 1, {reason: {kind: 'completed'}}));
  await f.watch.idle();
  assert.deepEqual(f.created, ['one']);
  assert.deepEqual(f.sent.map(x => x.text), ['Tool: read', 'Fork answer\n\nTurn 1: completed']);
  assert.equal(f.state.sessions.child, undefined);
  await f.watch.dispose();
});

test('parent-only live fork is accepted without startup listing', async () => {
  const f = fixture();
  await f.watch.start();
  f.emit({id: 'two', header: {parentSession: 'seed-source'}}, event('turn/start', 0));
  await f.watch.idle();
  assert.deepEqual(f.created, ['two']);
  await f.watch.dispose();
});

test('policy revoked during topic creation blocks all subsequent send', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({topic: () => { entered.resolve(); return gate.promise; }});
  await f.watch.start();
  f.emit(root('one'), event('turn/start', 0));
  f.emit(root('one'), answer(1, 1, 'Must not leave'));
  f.emit(root('one'), event('turn/end', 2, 1, {reason: {kind: 'completed'}}));
  await entered.promise;
  f.policy.allowed = false;
  gate.resolve();
  await f.watch.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.created.length, 1);
  await f.watch.dispose();
});

test('disabled/changed chat and newly archived session are checked for every output', async () => {
  const f = fixture();
  await f.watch.start();
  f.emit(root('one'), event('turn/start', 0));
  await f.watch.idle();
  f.policy.enabled = false;
  f.emit(root('one'), event('tool/call', 1, 1, {name: 'read'}));
  await f.watch.idle();
  f.policy.enabled = true;
  f.registry.archivedSessionIds.push('one');
  f.emit(root('one'), event('tool/call', 2, 1, {name: 'write'}));
  await f.watch.idle();
  assert.equal(f.sent.length, 0);
  await f.watch.dispose();
});

test('transport errors never affect agent or independent sessions; retry failed seq', async () => {
  let fail = true;
  const f = fixture({send: async (_chat, text) => {
    if (text === 'Tool: read' && fail) throw new Error('Transport failed');
  }, onError: () => { throw new Error('Reporter also fails'); }});
  await f.watch.start();
  const s = root('one');
  f.emit(s, event('turn/start', 0));
  f.emit(s, event('tool/call', 1, 1, {name: 'read'}));
  f.emit(s, answer(2, 1, 'Still works'));
  f.emit(s, event('turn/end', 3, 1, {reason: {kind: 'completed'}}));
  f.emit(root('two'), event('turn/start', 0));
  await f.watch.idle();
  assert.equal(f.errors.length, 1);
  assert.equal(f.state.sessions.one.cursor, 0);
  assert.deepEqual(f.state.sessions.one.handled, [2, 3]);
  assert.ok(f.created.includes('two'));
  fail = false;
  f.emit(s, event('tool/call', 1, 1, {name: 'read'}));
  await f.watch.idle();
  assert.equal(f.state.sessions.one.cursor, 3);
  assert.equal(f.sent.length, 2);
  await f.watch.dispose();
});

test('ambiguous topic errors latch rather than automatically creating duplicates', async () => {
  const f = fixture({topic: async () => { throw new Error('Unknown network outcome'); }});
  await f.watch.start();
  f.emit(root('one'), event('turn/start', 0));
  f.emit(root('one'), event('tool/call', 1, 1, {name: 'read'}));
  await f.watch.idle();
  assert.equal(f.created.length, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.state.sessions.one.cursor, -1);
  await f.watch.dispose();
  const g = fixture({state: structuredClone(f.state)});
  await g.watch.start();
  g.emit(root('one'), event('turn/start', 0));
  await g.watch.idle();
  assert.equal(g.created.length, 0);
  await g.watch.dispose();
});

test('dispose unsubscribes, aborts listing and gates work already waiting on async topic', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({topic: () => { entered.resolve(); return gate.promise; }});
  await f.watch.start();
  f.emit(root('one'), event('turn/start', 0));
  f.emit(root('one'), event('turn/end', 1, 1, {reason: {kind: 'completed'}}));
  await entered.promise;
  const disposed = f.watch.dispose();
  assert.equal(f.listeners.size, 0);
  gate.resolve();
  await disposed;
  await f.watch.dispose();
  await f.watch.start();
  assert.equal(f.sent.length, 0);
  assert.equal(f.listeners.size, 0);
});

test('common secrets are redacted in durable drafts and outbound answers', async () => {
  const f = fixture();
  await f.watch.start();
  const secretText = [
    `Bot ${'1'.repeat(8)}:${'a'.repeat(36)}`,
    `Bearer ${'x'.repeat(20)}`,
    `ghp_${'y'.repeat(30)} github_pat_${'z'.repeat(30)} sk-${'q'.repeat(30)}`,
    // Generated fixtures exercise masking without committing credential-shaped assignments.
    [['API_KEY', 'synthetic-secret'], ['TOKEN', 'synthetic token'], ['PASSWORD', 'synthetic-password']]
      .map(([key, value]) => key + '=' + JSON.stringify(value)).join(' '),
  ].join('\n');
  f.emit(root('one'), answer(0, 1, secretText));
  await f.watch.idle();
  const draft = f.state.sessions.one.turns['1'].text;
  assert.ok(draft.includes('[REDACTED]'));
  assert.ok(!draft.includes('synthetic'));
  assert.ok(!draft.includes('a'.repeat(36)));
  f.emit(root('one'), event('turn/end', 1, 1, {reason: {kind: 'completed'}}));
  await f.watch.idle();
  assert.ok(!f.sent[0].text.includes('synthetic'));
  await f.watch.dispose();
});

test('a hanging transport never blocks another session or the event listener', async () => {
  const gate = deferred(), entered = deferred();
  const f = fixture({send: async chat => {
    if (chat.sessionId === 'one') { entered.resolve(); await gate.promise; }
  }});
  await f.watch.start();
  assert.deepEqual(f.emit(root('one'), event('tool/call', 0, 1, {name: 'read'})), [undefined]);
  await entered.promise;
  f.emit(root('two'), event('turn/start', 0));
  // reconcile runs independently and does not wait for the first session send.
  await f.watch.reconcile();
  gate.resolve();
  await f.watch.idle();
  assert.deepEqual(f.created, ['one', 'two']);
  await f.watch.dispose();
});

test('topic is not recreated after persistence fails following successful creation', async () => {
  let fail = true;
  const f = fixture({persist: async state => {
    if (Object.keys(state.bindings).length && fail) {
      fail = false;
      throw new Error('Storage unavailable');
    }
  }});
  await f.watch.start();
  f.emit(root('one'), event('turn/start', 0));
  await f.watch.idle();
  f.emit(root('one'), event('tool/call', 1, 1, {name: 'read'}));
  await f.watch.idle();
  assert.equal(f.created.length, 1);
  assert.equal(f.errors.length, 1);
  await f.watch.dispose();
});

test('archive and workspace membership normalize session-prefixed identities', async () => {
  const f = fixture();
  f.registry.list = () => [
    {id: 'project-a', sessionIds: ['session-one', 'two']},
    {id: 'project-b'},
  ];
  f.registry.archivedSessionIds = ['session-two'];
  await f.watch.start();
  f.emit(root('one'), event('turn/start', 0));
  f.emit(root('two'), event('turn/start', 0));
  await f.watch.idle();
  assert.deepEqual(f.created, ['one']);
  f.registry.archivedSessionIds = ['one'];
  f.emit(root('session-one'), event('turn/start', 0));
  await f.watch.idle();
  assert.deepEqual(f.created, ['one']);
  await f.watch.dispose();
});

test('tool progress coalesces names and caps at ten per turn, without dropping final', async () => {
  const f = fixture();
  await f.watch.start();
  let seq = 0;
  const s = root('one');
  f.emit(s, event('turn/start', seq++));
  for (let i = 0; i < 30; i++) {
    f.emit(s, event('tool/call', seq++, 1, {name: `tool_${i}`}));
    f.emit(s, event('tool/call', seq++, 1, {name: `tool_${i}`}));
  }
  f.emit(s, answer(seq++, 1, 'Final answer'));
  f.emit(s, event('turn/end', seq++, 1, {reason: {kind: 'completed'}}));
  f.emit(s, event('turn/start', seq++, 2));
  f.emit(s, event('tool/call', seq++, 2, {name: 'tool_0'}));
  await f.watch.idle();
  assert.equal(f.sent.length, 12);
  assert.equal(f.sent[9].text, 'Tool: tool_9');
  assert.equal(f.sent[10].text, 'Final answer\n\nTurn 1: completed');
  assert.equal(f.sent[11].text, 'Tool: tool_0');
  assert.equal(f.state.sessions.one.cursor, seq - 1);
  await f.watch.dispose();
});

test('draft length cap counts Unicode codepoints and marks truncation', async () => {
  const f = fixture();
  await f.watch.start();
  f.emit(root('one'), answer(0, 1, '😀'.repeat(16001)));
  await f.watch.idle();
  assert.equal(f.state.sessions.one.turns['1'].text, `${'😀'.repeat(16000)}\n[Truncated]`);
  await f.watch.dispose();
});

test('off-period and old-generation backlog never become visible after re-enable', async () => {
  const gate = deferred(), entered = deferred();
  let first = true;
  const f = fixture({send: async () => {
    if (first) { first = false; entered.resolve(); await gate.promise; }
  }});
  f.policy.generation = 1;
  await f.watch.start();
  f.emit(root('one'), event('tool/call', 0, 1, {name: 'read'}));
  await entered.promise;
  f.emit(root('one'), answer(1, 1, 'queued before revoke'));
  f.policy.enabled = false; f.policy.generation++;
  f.emit(root('one'), answer(2, 2, 'off-period private content'));
  f.policy.enabled = true; f.policy.generation++;
  f.emit(root('one'), event('turn/end', 3, 2, {reason: {kind: 'completed'}}));
  gate.resolve();
  await f.watch.idle();
  assert.ok(f.sent.every(item => !/off-period|queued before/.test(item.text)));
  f.emit(root('one'), answer(4, 3, 'new authorized answer'));
  f.emit(root('one'), event('turn/end', 5, 3, {reason: {kind: 'completed'}}));
  await f.watch.idle();
  assert.ok(f.sent.some(item => item.text.includes('new authorized answer')));
  await f.watch.dispose();
});

test('malformed persisted binding cannot select another chat', async () => {
  const state = {bindings: {[JSON.stringify([101, 'one'])]: {chatId: 202, threadId: 9, sessionId: 'one'}}};
  const f = fixture({state});
  await f.watch.start();
  f.emit(root('one'), event('tool/call', 0, 1, {name: 'read'}));
  await f.watch.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.created.length, 0);
  assert.ok(f.errors.some(item => /persisted topic/.test(item.error.message)));
  await f.watch.dispose();
});

test('live ownership fence excludes legacy child without origin but permits ordinary fork', async () => {
  const f = fixture();
  const child = {id: 'child'}, parent = {id: 'parent'};
  let ownershipChecks = 0;
  f.ctx.agents = {
    get: id => ({child, parent})[id],
    isOwnedBy: (id, owner) => { ownershipChecks++; return id === 'child' && owner === parent; },
  };
  await f.watch.start();
  f.emit({id: 'child', header: {parentSession: 'parent', isSeeded: true}}, event('tool/call', 0, 1, {name: 'read'}));
  f.emit({id: 'one', header: {parentSession: 'parent', isSeeded: true}}, answer(0, 1, 'ordinary fork'));
  f.emit({id: 'one', header: {parentSession: 'parent', isSeeded: true}}, event('turn/end', 1, 1, {reason: {kind: 'completed'}}));
  await f.watch.idle();
  assert.ok(ownershipChecks > 0);
  assert.deepEqual(f.created, ['one']);
  assert.equal(f.sent.length, 1);
  assert.ok(f.sent[0].text.includes('ordinary fork'));
  await f.watch.dispose();
});

test('listing failure is contained; listener still watches live turns', async () => {
  const f = fixture();
  f.ctx.sessionController.list = async () => { throw new Error('List unavailable'); };
  await f.watch.start();
  f.emit(root('one'), event('turn/start', 0));
  await f.watch.idle();
  assert.equal(f.errors[0].context.operation, 'reconcile');
  assert.deepEqual(f.created, ['one']);
  await f.watch.dispose();
});
