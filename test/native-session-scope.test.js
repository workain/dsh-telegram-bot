import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createSessionWatch} from '../session-watch.js';

// Actual native modules, never plugin.apply or a Host/model/network. Optional
// outside DSH installations; DSH_NATIVE_ROOT selects an explicit installation.
async function nativeModules() {
  const roots = process.env.DSH_NATIVE_ROOT
    ? [pathToFileURL(join(resolve(process.env.DSH_NATIVE_ROOT), 'package.json'))]
    : [import.meta.url, pathToFileURL(join(homedir(), '.local/share/deepseek-harness/package.json'))];
  for (const root of roots) {
    const require = createRequire(root);
    let paths;
    try {
      paths = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-scope', '@deepseek-ai/dsh-session']
        .map(name => require.resolve(name));
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' && !process.env.DSH_NATIVE_ROOT) continue;
      throw error;
    }
    const [cordis, scope, session] = await Promise.all(paths.map(path => import(pathToFileURL(path))));
    return {...cordis, ...scope, ...session};
  }
}

const native = await nativeModules();
test('installed native Cordis/session scope contract (no Host)', {
  skip: native ? false : 'Native DSH modules unavailable; set DSH_NATIVE_ROOT to run real integration',
}, async t => {
  const {Context, createScope, SessionStore} = native;
  const root = new Context();
  t.after(() => root.fiber.dispose());
  const sessionId = 'session-native-scope-fixture';
  const registry = {archivedSessionIds: [], list: () => [{id: 'fixture-workspace', sessionIds: [sessionId]}]};
  const controller = {list: async () => ({items: []})};
  // Sibling provider is important: root-provided services would conceal the
  // missing inject declaration by making direct reads accidentally succeed.
  await root.plugin(ctx => {
    ctx.provide('workspaceRegistry', registry);
    ctx.provide('sessionController', controller);
  });
  let observer;
  await root.plugin(ctx => { observer = ctx; });

  await t.test('get resolves sibling services; direct properties require inject', () => {
    assert.equal(observer.get('workspaceRegistry').list()[0].id, 'fixture-workspace');
    assert.equal(typeof observer.get('sessionController').list, 'function');
    assert.throws(() => observer.workspaceRegistry, /without inject/);
    assert.throws(() => observer.sessionController, /without inject/);
  });

  const producer = createScope(root, {});
  const consumer = createScope(observer, {});
  const store = new SessionStore(producer.ctx);
  const session = store.create(sessionId);
  await t.test('untagged listeners see native events; unrelated scopes require global', () => {
    const plain = [], scoped = [], global = [];
    const disposers = [
      observer.on('session/event', (subject, event) => plain.push([subject, event])),
      consumer.ctx.on('session/event', (subject, event) => scoped.push([subject, event])),
      consumer.ctx.on('session/event', (subject, event) => global.push([subject, event]), {global: true}),
    ];
    try {
      const event = session.append('turn/start', {turn: 1});
      assert.equal(event.seq, 0);
      assert.equal(typeof event.seq, 'number');
      assert.equal(event.type, 'turn/start');
      assert.deepEqual(plain, [[session, event]]);
      assert.deepEqual(scoped, []);
      assert.deepEqual(global, [[session, event]]);
    } finally { disposers.forEach(dispose => dispose()); }
  });

  await t.test('watch admits a manual binding with no workspace opt-in and mirrors native work', async () => {
    const state = {};
    const sent = [], errors = [];
    const watch = createSessionWatch({
      ctx: consumer.ctx,
      getPolicy: () => ({enabled: true, allowed: true, chatId: 123,
        workspaceIds: [], boundSessionIds: [sessionId], mirrorMessages: true}),
      getState: () => state,
      persist: async () => {},
      ensureTopic: async id => ({chatId: 123, threadId: 456, sessionId: id}),
      send: async (_chat, text) => { sent.push(text); },
      onError: (error, context) => { errors.push({message: error.message, ...context}); },
    });
    try {
      await watch.start();
      const events = [
        session.append('turn/start', {turn: 2}),
        session.append('tool/call', {turn: 2, step: 0, id: 'fixture-tool', name: 'fixture_tool', input: {}}),
        session.append('assistant/message', {turn: 2, step: 0, stream: [],
          message: {id: 'fixture-answer', role: 'assistant', content: [{type: 'text', text: 'Native fixture answer'}]}}, {surfaceOp: 'append'}),
        session.append('turn/end', {turn: 2, reason: {kind: 'completed'}}),
      ];
      await watch.idle();
      assert.deepEqual(errors, []);
      assert.deepEqual(events.map(event => [event.seq, event.type]), [
        [1, 'turn/start'], [2, 'tool/call'], [3, 'assistant/message'], [4, 'turn/end'],
      ]);
      assert.equal(state.sessions[sessionId]?.cursor, 4);
      assert.ok(sent.includes('Tool: fixture_tool'));
      assert.ok(sent.includes('🤖 Native fixture answer'));
      assert.ok(sent.includes('Turn 2: completed'));
    } finally { await watch.dispose(); }
  });
});
