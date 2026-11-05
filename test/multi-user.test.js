import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import test from 'node:test'
import { validatePluginState } from '../state-validation.js'

async function until(predicate, label) {
  const deadline = Date.now() + 3000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await new Promise(setImmediate)
  }
}

// All identities, paths and Bot API responses below are synthetic; no network.
async function scenario(entries) {
  const home = await mkdtemp(join(tmpdir(), 'telegram-multi-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const statePath = join(home, 'telegram-workain/state.json')
  const legacy = { sessionId: 'session-web', chatId: 100, threadId: 7001, title: 'Existing topic', cwd: '/tmp/project' }
  const owner = { userId: 42, chatId: 100, workspaceIds: ['registered'], paused: false, generation: 1 }
  await mkdir(join(home, 'telegram-workain'))
  await writeFile(statePath, JSON.stringify({ version: 3, sessions: { 'session-web': legacy }, threads: { '100:7001': 'session-web' },
    subscription: owner, watch: { bindings: { '[100,"session-web"]': legacy }, bindingErrors: {},
      sessions: { 'session-web': { cursor: 5, handled: [], turns: {}, generation: 1 } } } }))
  const emitter = new EventEmitter(), calls = [], prompts = [], cleanups = [], logs = []
  const workspace = { id: 'registered', path: '/tmp/project', title: 'Project', sessionIds: ['web'] }
  const secondary = { id: 'secondary', path: '/tmp/secondary', title: 'Secondary', sessionIds: [] }
  const agent = { session: { id: 'session-web', header: { cwd: workspace.path } } }
  const controller = {
    async list() { return { items: [{ sessionId: 'session-web', running: false, blank: false }] } },
    async resolveAgent(id) { assert.equal(id, 'session-web'); return { agent } },
    async prompt(request) { prompts.push(structuredClone(request)); return { accepted: true } },
    async create() { assert.fail('Connecting an original session must not create a session') },
    async fork() { assert.fail('Legacy session callbacks must never fork') },
  }
  const registry = { list: () => [workspace, secondary], archivedSessionIds: [] }
  const services = { sessionController: controller, workspaceRegistry: registry,
    credentials: { resolve: async () => ({ value: 'SYNTHETIC_TEST_TOKEN' }) },
    agents: { get: () => agent },
    sessionQuery: { readTitleSnapshot: async () => ({ title: { title: 'Existing topic' } }),
      readSurface: async () => ({ events: [] }), readSession: async () => ({ events: [] }) } }
  const ctx = { sessionController: controller, workspaceRegistry: registry, get: name => services[name],
    on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn) },
    effect(fn) { cleanups.push(fn()) }, logger: { info() {}, warn: text => logs.push(text) } }
  const config = { enabled: true, tokenRef: 'TEST_TOKEN', allowedUsers: entries, allowedChats: [], cwd: workspace.path }
  let pendingPoll, polls = 0, topicId = 7001, messageId = 0
  const original = https.request
  https.request = (options, callback) => {
    const method = String(options.path).split('/').at(-1)
    const request = new EventEmitter(), response = new EventEmitter()
    response.statusCode = 200
    response.setEncoding = () => {}
    process.nextTick(() => callback(response))
    const deliver = result => setImmediate(() => {
      response.emit('data', JSON.stringify({ ok: true, result }))
      response.emit('end'); request.emit('close')
    })
    request.destroy = error => { if (error) request.emit('error', error); request.emit('close') }
    request.end = body => {
      const payload = JSON.parse(body || '{}')
      // Capture persisted pins at the exact outbound boundary, before response.
      const durable = JSON.parse(readFileSync(statePath, 'utf8'))
      calls.push({ method, body: payload, pins: durable.userPins })
      if (method === 'getUpdates') { polls++; pendingPoll = deliver; return }
      if (method === 'getMe') return deliver({ id: 1, username: 'testbot' })
      if (method === 'createForumTopic') return deliver({ message_thread_id: ++topicId })
      if (method === 'sendMessage' || method === 'editMessageText') return deliver({ message_id: ++messageId })
      deliver(true)
    }
    return request
  }
  const { apply } = await import(`../index.js?multi=${encodeURIComponent(home)}`)
  apply(ctx, config)
  await until(() => pendingPoll, 'startup poll')
  return { calls, prompts, logs, config, legacy,
    async state() { return JSON.parse(await readFile(statePath, 'utf8')) },
    async feed(...updates) {
      const before = polls, deliver = pendingPoll
      pendingPoll = undefined
      assert.ok(deliver)
      deliver(updates)
      await until(() => polls > before && pendingPoll, 'next poll')
    },
    emit(seq, type, data) { emitter.emit('session/event', { id: 'session-web', header: { cwd: workspace.path } }, { seq, type, data }) },
    async cursor(chatId, seq) {
      await until(async () => {
        try { return JSON.parse(await readFile(statePath, 'utf8')).watches?.[chatId]?.sessions?.['session-web']?.cursor >= seq }
        catch { return false }
      }, `cursor ${chatId}:${seq}`)
    },
    request(type, data) {
      const listeners = emitter.listeners(type)
      assert.equal(listeners.length, 1, 'exactly one terminal Telegram answerer')
      return listeners[0]({ agent, ...data }, () => 'downstream')
    },
    async restart() {
      for (const fn of cleanups.splice(0)) await fn?.()
      emitter.removeAllListeners()
      pendingPoll = undefined
      apply(ctx, config)
      await until(() => pendingPoll, 'recomposition poll')
    },
    async cleanup() {
      for (const fn of cleanups) await fn?.()
      https.request = original
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
    },
  }
}
const user = (id, username) => ({ id, ...(username ? { username } : {}) })
const message = (id, from, chatId, text, thread = 1) => ({ update_id: id,
  message: { message_id: id, date: 1, from, chat: { id: chatId, type: 'private' }, text, message_thread_id: thread } })
const callback = (id, from, chatId, data, thread = 1) => ({ update_id: id, callback_query: {
  id: `callback-${id}`, from, data, message: { message_id: id, chat: { id: chatId, type: 'private' }, message_thread_id: thread } } })
const sent = host => host.calls.filter(call => call.method === 'sendMessage')
const keyboards = host => sent(host).filter(call => call.body.reply_markup?.inline_keyboard?.flat().some(button => button.callback_data.startsWith('a:')))
const answer = (host, start, text) => {
  host.emit(start, 'turn/start', { turn: start })
  host.emit(start + 1, 'assistant/message', { turn: start, message: { content: [{ type: 'text', text }] } })
  host.emit(start + 2, 'turn/end', { turn: start, reason: { kind: 'completed' } })
}

for (const username of [false, true]) test(`independent chats with ${username ? 'numeric and pinned username' : 'multiple numeric'} operators preserve v3 topics`, async () => {
  const second = user(84, username ? 'Alice_User' : undefined)
  const host = await scenario(['42', username ? '@alice_user' : '84'])
  try {
    await host.feed(message(1, user(42), 100, '/watch registered'))
    await host.feed(message(2, second, 200, '/watch secondary'))
    let state = await host.state()
    assert.deepEqual(state.sessions['session-web'], host.legacy, 'first user topic is not remapped or reset')
    assert.deepEqual(state.subscriptions[100].workspaceIds, ['registered'])
    assert.deepEqual(state.subscriptions[200].workspaceIds, ['secondary'])
    assert.deepEqual(state.subscription, state.subscriptions[100], 'legacy subscription alias remains first chat')
    assert.deepEqual(state.watch, state.watches[100], 'legacy watch alias remains first chat')
    assert.equal(state.watch.sessions['session-web'].cursor, 5, 'legacy cursor survives second operator')
    if (username) {
      assert.equal(state.userPins['@alice_user'], '84')
      assert.ok(host.calls.filter(call => call.body.chat_id === 200).every(call => call.pins['@alice_user'] === '84'), 'pin persisted before first operation/reply')
      const count = host.calls.length
      await host.feed(message(3, user(85, 'alice_user'), 201, '/watch all'))
      assert.ok(!host.calls.slice(count).some(call => call.body.chat_id === 201), 'reused username does not authorize a new ID')
      assert.equal((await host.state()).subscriptions[201], undefined)
    }
    // All historical open actions now bind the exact same session, per chat.
    await host.feed(callback(4, second, 200, 's:session-web'), callback(5, second, 200, 'c:session-web'), callback(6, second, 200, 'f:session-web'))
    await host.feed(callback(7, user(42), 100, 'c:session-web'))
    state = await host.state()
    const secondKey = '[200,"session-web"]'
    assert.equal(state.sessions[secondKey].threadId, 7002)
    assert.equal(state.sessions['session-web'].threadId, 7001)
    assert.equal(state.threads['100:7001'], 'session-web')
    assert.equal(state.threads['200:7002'], 'session-web')
    assert.equal(host.calls.filter(call => call.method === 'createForumTopic').length, 1)
    await host.feed(message(8, second, 200, '/watch registered'))
    state = await host.state()
    assert.deepEqual(state.subscriptions[200].workspaceIds, ['secondary', 'registered'])
    assert.deepEqual(state.subscriptions[100].workspaceIds, ['registered'])
    answer(host, 6, 'shared Web response')
    await host.cursor(100, 8); await host.cursor(200, 8)
    assert.deepEqual(sent(host).filter(call => call.body.text.includes('shared Web response')).map(call => [call.body.chat_id, call.body.message_thread_id]).sort(), [[100, 7001], [200, 7002]])
    await host.feed(message(9, user(42), 100, 'first queued prompt', 7001), message(10, second, 200, 'second queued prompt', 7002))
    assert.deepEqual(host.prompts.map(prompt => [prompt.sessionId, prompt.requestId, prompt.mode]), [
      ['session-web', 'telegram:100:9', 'queue'], ['session-web', 'telegram:200:10', 'queue'],
    ])
    // Last sender gets one native approval, not a duplicate in every chat.
    const before = keyboards(host).length
    const approval = host.request('approval/request', { toolName: 'bash', signal: new AbortController().signal })
    await until(() => keyboards(host).length === before + 1, 'one approval keyboard')
    const prompt = keyboards(host).at(-1)
    assert.equal(prompt.body.chat_id, 200)
    await new Promise(setImmediate)
    await host.feed(message(11, user(42), 100, '/watch off'))
    const allow = prompt.body.reply_markup.inline_keyboard.flat().find(button => button.callback_data.startsWith('a:y:')).callback_data
    await host.feed(callback(12, second, 200, allow, 7002))
    assert.equal(await approval, 'allowed-once', 'other operator watch changes cannot release this approval')
    assert.equal(keyboards(host).length, before + 1)
    answer(host, 9, 'only second still watching')
    await host.cursor(200, 11)
    assert.deepEqual(sent(host).filter(call => call.body.text.includes('only second still watching')).map(call => call.body.chat_id), [200])
    await host.feed(message(13, user(42), 100, '/watch on'))
    host.config.allowedUsers = ['42']
    const revokedBoundary = host.calls.length
    answer(host, 12, 'only first after revocation')
    await host.cursor(100, 14)
    await host.feed(message(14, second, 200, '/ping'))
    host.emit(15, 'session/title', { title: 'New title' })
    await host.cursor(100, 15)
    assert.ok(!host.calls.slice(revokedBoundary).some(call => call.body.chat_id === 200), 'revocation blocks every subsequent chat write, including titles')
    state = await host.state()
    validatePluginState(state)
    assert.equal(state.sessions[secondKey].threadId, 7002, 'revocation keeps durable mappings intact')
    await host.restart()
    host.config.allowedUsers = ['42', username ? '@alice_user' : '84']
    await host.feed(callback(15, second, 200, 'c:session-web'))
    assert.equal(host.calls.filter(call => call.method === 'createForumTopic').length, 1, 'recomposition reuses both existing topics')
    state = await host.state()
    validatePluginState(state)
    assert.equal(state.watches[100].sessions['session-web'].cursor, 15)
    assert.equal(state.sessions['session-web'].threadId, 7001)
  } finally { await host.cleanup() }
})

test('multi-chat state validation fails closed on damaged reverse links and observer namespace', () => {
  const one = { sessionId: 'session-web', chatId: 100, threadId: 7 }
  const two = { sessionId: 'session-web', chatId: 200, threadId: 8 }
  const fixture = { version: 3, sessions: { 'session-web': one, '[200,"session-web"]': two },
    threads: { '100:7': 'session-web', '200:8': 'session-web' }, subscriptions: {
      100: { userId: 42, chatId: 100 }, 200: { userId: 84, chatId: 200 } },
    watches: { 100: { bindings: { '[100,"session-web"]': one } }, 200: { bindings: { '[200,"session-web"]': two } } } }
  assert.doesNotThrow(() => validatePluginState(fixture))
  for (const damage of [
    state => { delete state.threads['100:7'] },
    state => { state.sessions['[200,"session-web"]'].chatId = 100 },
    state => { state.watches[200].bindings['[200,"session-web"]'].threadId = 9 },
    state => { state.watches[200] = state.watches[100] },
  ]) {
    const state = structuredClone(fixture)
    damage(state)
    assert.throws(() => validatePluginState(state), /Invalid Telegram/)
  }
})
