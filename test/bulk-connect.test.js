import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

async function until(predicate, description) {
  const deadline = Date.now() + 3000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`)
    await new Promise(setImmediate)
  }
}

// Generated synthetic Bot API-shaped fixture; never a real credential.
const botFixture = [String(987654321), ['SYNTHETIC', 'BULK', 'TEST', 'ONLY'].join('_').repeat(2)].join(':')
const message = (id, text, thread = 1) => ({ update_id: id, message: {
  message_id: id, date: 1, from: { id: 42 }, chat: { id: 100, type: 'private' }, message_thread_id: thread, text,
} })
const callback = (id, data) => ({ update_id: id, callback_query: {
  id: `bulk-callback-${id}`, from: { id: 42 }, data,
  message: { message_id: id, chat: { id: 100, type: 'private' }, message_thread_id: 1 },
} })
const buttons = call => call.body.reply_markup?.inline_keyboard?.flat() ?? []
const menus = host => host.calls.filter(call => ['sendMessage', 'editMessageText'].includes(call.method))
const topics = host => host.calls.filter(call => call.method === 'createForumTopic')

async function scenario() {
  const home = await mkdtemp(join(tmpdir(), 'telegram-bulk-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const now = Date.now(), hour = 60 * 60 * 1000
  const workspaces = [
    { id: 'alpha', path: '/tmp/bulk-alpha', title: 'Alpha', sessionIds: ['running', 'recent', 'day', 'old', 'archived', 'child', 'blank'] },
    { id: 'beta', path: '/tmp/bulk-beta', title: 'Beta', sessionIds: ['other'] },
  ]
  const rows = [
    { sessionId: 'session-running', running: true, updatedAt: now - 72 * hour },
    { sessionId: 'session-recent', running: false, updatedAt: now - 10 * 60 * 1000 },
    { sessionId: 'session-day', running: false, updatedAt: now - 4 * hour },
    { sessionId: 'session-old', running: false, updatedAt: now - 48 * hour },
    { sessionId: 'session-archived', running: true, updatedAt: now },
    { sessionId: 'session-child', running: true, updatedAt: now, origin: 'subagent' },
    { sessionId: 'session-orphan', running: true, updatedAt: now },
    { sessionId: 'session-blank', running: true, updatedAt: now, blank: true },
    { sessionId: 'session-other', running: true, updatedAt: now },
  ].map(row => ({ blank: false, cwd: '/tmp/bulk-alpha', ...row }))
  const calls = [], prompts = [], creates = [], forks = [], historyReads = [], listCalls = [], resolved = []
  const cleanups = [], logs = [], emitter = new EventEmitter(), agents = new Map()
  const controller = {
    async list(options, signal) {
      assert.deepEqual(options, {})
      assert.ok(signal instanceof AbortSignal)
      listCalls.push(options)
      return { items: rows }
    },
    async create(options) { creates.push(options); return { sessionId: 'session-unexpected-new' } },
    async fork(options) { forks.push(options); return { sessionId: 'session-unexpected-fork' } },
    async resolveAgent(id) {
      resolved.push(id)
      assert.ok(rows.some(row => row.sessionId === id), 'resolve only native original identities')
      if (!agents.has(id)) agents.set(id, { session: { id, header: { cwd: '/tmp/bulk-alpha' }, append() {} } })
      return { agent: agents.get(id) }
    },
    async prompt(request) { prompts.push(structuredClone(request)); return { accepted: true } },
  }
  const registry = { list: () => workspaces, get: id => workspaces.find(workspace => workspace.id === id), archivedSessionIds: ['archived'] }
  const history = id => {
    historyReads.push(id)
    return { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'HISTORY_MUST_NOT_BE_REPLAYED' }] } } }] }
  }
  const services = {
    sessionController: controller, workspaceRegistry: registry,
    agents: { get: id => agents.get(id) }, credentials: { resolve: async () => ({ value: botFixture }) },
    sessionQuery: {
      readTitleSnapshot: async id => ({ title: { title: `Original ${id}` } }),
      readSurface: async id => history(id), readSession: async id => history(id),
      listSessions: async () => { historyReads.push('legacy-list'); return [] },
    },
  }
  const ctx = {
    sessionController: controller, workspaceRegistry: registry, get: name => services[name],
    on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn) },
    effect(fn) { cleanups.push(fn()) },
    logger: { info: text => logs.push(text), warn: text => logs.push(text) },
  }
  let pendingPoll, polls = 0, messageId = 0, topicId = 7000, updateId = 0
  const originalRequest = https.request
  https.request = (options, callback) => {
    assert.equal(options.host, 'api.telegram.org', 'all network traffic uses the synthetic Telegram transport')
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
      calls.push({ method, body: payload })
      if (method === 'getUpdates') { polls++; pendingPoll = deliver; return }
      if (method === 'getMe') return deliver({ id: 1, username: 'syntheticbulkbot' })
      if (method === 'createForumTopic') return deliver({ message_thread_id: ++topicId })
      if (['sendMessage', 'editMessageText'].includes(method)) return deliver({ message_id: ++messageId })
      deliver(true)
    }
    return request
  }
  const cleanup = async () => {
    for (const fn of cleanups) await fn?.()
    https.request = originalRequest
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  }
  try {
    const { apply } = await import(`../index.js?bulk=${encodeURIComponent(home)}`)
    apply(ctx, { enabled: true, tokenRef: 'SYNTHETIC_BULK_REFERENCE', allowedUsers: ['42'], allowedChats: ['100'], cwd: workspaces[0].path, language: 'en', showThinking: false })
    await until(() => pendingPoll, 'initial long poll')
    const feed = async update => {
      const before = polls, deliver = pendingPoll
      pendingPoll = undefined
      assert.ok(deliver, 'feed only into a pending long poll')
      deliver([update])
      await until(() => polls > before && pendingPoll, 'update processed and next long poll')
    }
    return {
      calls, prompts, creates, forks, historyReads, listCalls, resolved, logs, cleanup,
      command: (text, thread) => feed(message(++updateId, text, thread)),
      click: data => feed(callback(++updateId, data)),
      async bindings() {
        return JSON.parse(await readFile(join(home, 'telegram-workain/state.json'), 'utf8')).sessions
      },
    }
  } catch (error) { await cleanup(); throw error }
}

function unchangedSessions(host) {
  assert.deepEqual(host.creates, [], 'opening/bulk must not create sessions')
  assert.deepEqual(host.forks, [], 'opening/bulk must not fork sessions')
  assert.deepEqual(host.historyReads, [], 'opening/bulk must not read preview/history or legacy catalog')
  assert.ok(menus(host).every(call => !String(call.body.text).includes('HISTORY_MUST_NOT_BE_REPLAYED')))
}

function assertBulkButtons(call, scope) {
  const actual = buttons(call).map(button => button.callback_data)
  for (const range of ['running', 'hour', 'day']) assert.ok(actual.includes(`t:${range}:${scope}`), `visible ${range} bulk action for ${scope}`)
}

test('/sessions exposes three bulk actions globally and for each workspace', async () => {
  const host = await scenario()
  try {
    await host.command('/sessions')
    assertBulkButtons(menus(host).at(-1), 'all')
    await host.click('w:all')
    const allMenu = menus(host).at(-1)
    assertBulkButtons(allMenu, 'all')
    const ids = buttons(allMenu).map(button => button.callback_data)
    assert.ok(ids.includes('s:session-recent'))
    for (const id of ['archived', 'child', 'orphan', 'blank']) assert.ok(!ids.includes(`s:session-${id}`), `exclude ${id}`)
    await host.click('w:alpha')
    assertBulkButtons(menus(host).at(-1), 'alpha')
    assert.ok(!buttons(menus(host).at(-1)).some(button => button.callback_data === 's:session-other'))
    assert.equal(topics(host).length, 0, 'browsing is not opening')
    assert.ok(host.listCalls.length > 0, 'catalog uses native list returning items')
    unchangedSessions(host)
  } finally { await host.cleanup() }
})

test('s:, c: and legacy f: directly reuse the same original topic without preview/choice/history', async () => {
  const host = await scenario()
  try {
    await host.command('/sessions')
    await host.click('w:all')
    const offset = host.calls.length
    await host.click('s:session-recent')
    assert.equal(topics(host).length, 1, 's: opens immediately, without Continue/Fork choice')
    for (const prefix of ['c', 'f', 's']) await host.click(`${prefix}:session-recent`)
    assert.equal(topics(host).length, 1, 'old callback buttons must reuse original topic')
    const bindings = await host.bindings()
    assert.deepEqual(Object.keys(bindings), ['session-recent'])
    const thread = bindings['session-recent'].threadId
    assert.equal(thread, 7001)
    const openedMenus = host.calls.slice(offset).filter(call => ['sendMessage', 'editMessageText'].includes(call.method))
    assert.ok(openedMenus.every(call => buttons(call).every(button => !/^(?:c|f):/.test(button.callback_data))), 'no Continue/Fork buttons')
    assert.ok(openedMenus.every(call => !/Continue in Telegram|No assistant messages yet|Workspace:/.test(call.body.text)), 'no preview page')
    await host.command('prompt the original session', thread)
    assert.deepEqual(host.prompts, [{ sessionId: 'session-recent', requestId: 'telegram:100:7', mode: 'queue', content: [{ type: 'text', text: 'prompt the original session' }] }])
    unchangedSessions(host)
  } finally { await host.cleanup() }
})

test('hour bulk includes recent idle plus running, excludes archived/child/orphan, and repeat is idempotent', async () => {
  const host = await scenario()
  try {
    await host.command('/sessions')
    await host.click('t:hour:all')
    const expected = ['session-other', 'session-recent', 'session-running']
    assert.deepEqual(Object.keys(await host.bindings()).sort(), expected)
    assert.equal(topics(host).length, 3)
    await host.click('t:hour:all')
    await host.command('/connect hour')
    assert.equal(topics(host).length, 3, 'repeated bulk actions never duplicate topics')
    assert.deepEqual(Object.keys(await host.bindings()).sort(), expected)
    const thread = (await host.bindings())['session-recent'].threadId
    await host.command('bulk topic prompt', thread)
    assert.equal(host.prompts.length, 1)
    assert.equal(host.prompts[0].sessionId, 'session-recent', 'bulk topic remains the original Web session')
    unchangedSessions(host)
  } finally { await host.cleanup() }
})

test('scoped bulk buttons and /connect running|hour|day [workspace] respect native membership and windows', async () => {
  const host = await scenario()
  try {
    await host.command('/connect running alpha')
    assert.deepEqual(Object.keys(await host.bindings()), ['session-running'])
    await host.command('/connect hour alpha')
    assert.deepEqual(Object.keys(await host.bindings()).sort(), ['session-recent', 'session-running'])
    await host.command('/connect day alpha')
    assert.deepEqual(Object.keys(await host.bindings()).sort(), ['session-day', 'session-recent', 'session-running'])
    for (const range of ['running', 'hour', 'day']) await host.click(`t:${range}:alpha`)
    assert.equal(topics(host).length, 3, 'workspace-scoped buttons reuse original topics')
    await host.command('/connect running')
    assert.deepEqual(Object.keys(await host.bindings()).sort(), ['session-day', 'session-other', 'session-recent', 'session-running'])
    await host.command('/connect day')
    assert.equal(topics(host).length, 4, 'day excludes old idle and invalid identities across workspaces')
    unchangedSessions(host)
  } finally { await host.cleanup() }
})
