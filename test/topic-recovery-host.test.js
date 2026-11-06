import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import test from 'node:test'

const sid = 'session-original'
const attemptKey = `100:${sid}`
const watchKey = JSON.stringify([100, sid])
const unrelated = { sessionId: 'session-unrelated', chatId: 200, threadId: 8001, title: 'Existing unrelated binding' }
const buttons = call => call.body.reply_markup?.inline_keyboard?.flat() ?? []
const message = (id, text) => ({ update_id: id, message: {
  message_id: id, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, text,
} })
const callback = (id, callbackData, userId = 42) => ({ update_id: id, callback_query: {
  id: `synthetic-recovery-${id}`, from: { id: userId }, data: callbackData,
  message: { message_id: id, chat: { id: 100, type: 'private' } },
} })
async function until(predicate, label) {
  const deadline = Date.now() + 3000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`)
    await new Promise(setImmediate)
  }
}

// Independent native Host fixture, not an import of a test-registering module.
// Every update and HTTPS response is synthetic; the original transport is never called.
async function scenario(firstOutcome) {
  const home = await mkdtemp(join(tmpdir(), 'telegram-topic-recovery-host-'))
  const previousHome = process.env.DSH_HOME
  const previousNodeEnv = process.env.NODE_ENV
  process.env.DSH_HOME = home
  process.env.NODE_ENV = 'test' // Native transport's documented test-only pacing bypass.
  const statePath = join(home, 'telegram-workain/state.json')
  await mkdir(join(home, 'telegram-workain'))
  await writeFile(statePath, JSON.stringify({ version: 3,
    sessions: { [unrelated.sessionId]: unrelated }, threads: { '200:8001': unrelated.sessionId },
  }))
  const emitter = new EventEmitter(), calls = [], cleanups = []
  const forbidden = { create: 0, fork: 0, prompt: 0 }
  const workspace = { id: 'registered', path: '/tmp/synthetic-topic-recovery', title: 'Synthetic', sessionIds: ['original'] }
  const agent = { session: { id: sid, header: { cwd: workspace.path } } }
  const listRequests = [], projectionRequests = []
  const controller = {
    async list(options) {
      assert.deepEqual(options, {})
      listRequests.push(options)
      return { items: [{ sessionId: sid, blank: false, running: false }] }
    },
    async resolveAgent(id) { assert.equal(id, sid); return { agent } },
    async projections(request) {
      assert.deepEqual(request, { sessionId: sid })
      projectionRequests.push(request)
      return { kind: 'sequenced', asOfSeq: 0 }
    },
    async page() { return { events: [], hasMore: false } },
    async create() { forbidden.create++; assert.fail('Recovery must not create a native session') },
    async fork() { forbidden.fork++; assert.fail('Recovery must not fork a native session') },
    async prompt() { forbidden.prompt++; assert.fail('Recovery must not prompt a native session') },
  }
  const registry = { list: () => [workspace], archivedSessionIds: [] }
  const services = {
    sessionController: controller, workspaceRegistry: registry,
    credentials: { resolve: async () => ({ value: [String(123456789), randomBytes(24).toString('hex')].join(':') }) },
    webServer: { getOrigin: () => 'https://synthetic-recovery.example.test' },
    agents: { get: id => id === sid ? agent : undefined },
    sessionQuery: {
      readTitleSnapshot: async () => ({ title: { title: 'Original ordinary session' } }),
      readSurface: async () => ({ events: [] }), readSession: async () => ({ events: [] }),
    },
  }
  const ctx = {
    sessionController: controller, workspaceRegistry: registry, get: name => services[name],
    on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn) },
    effect(fn) { cleanups.push(fn()) }, logger: { info() {}, warn() {} },
  }
  // Mutable synthetic authorization input; no disk configuration is read or changed.
  const allowedUsers = ['42']
  let pendingPoll, polls = 0, messageId = 0, createCount = 0, feeding = false
  const originalRequest = https.request
  https.request = (options, onResponse) => {
    assert.equal(options.servername, 'api.telegram.org', 'only intercepted Bot API requests are expected')
    const method = String(options.path).split('/').at(-1)
    const request = new EventEmitter(), response = new EventEmitter()
    response.statusCode = 200
    response.setEncoding = () => {}
    process.nextTick(() => onResponse(response))
    const deliverEnvelope = envelope => setImmediate(() => {
      response.emit('data', JSON.stringify(envelope))
      response.emit('end'); request.emit('close')
    })
    const deliver = result => deliverEnvelope({ ok: true, result })
    request.destroy = error => { if (error) request.emit('error', error); request.emit('close') }
    request.end = body => {
      const payload = JSON.parse(body || '{}')
      const call = { method, body: payload }
      calls.push(call)
      if (method === 'getUpdates') { polls++; pendingPoll = deliver; return }
      if (method === 'getMe') return deliver({ id: 1, username: 'synthetic_recovery_bot' })
      if (method === 'createForumTopic') {
        createCount++
        if (createCount === 1 && firstOutcome === 'rejected') {
          // Real requestOnce must decode error_code, and createTopic must keep it
          // while wrapping the Topics setup hint; otherwise the pending latch sticks.
          return deliverEnvelope({ ok: false, error_code: 400, description: 'Bad Request: Topics disabled' })
        }
        if (createCount === 1 && firstOutcome === 'unknown') {
          return setImmediate(() => { request.emit('error', new Error('Synthetic connection lost')); request.emit('close') })
        }
        return deliver({ message_thread_id: 7001 })
      }
      if (method === 'sendMessage' || method === 'editMessageText') {
        call.responseMessageId = method === 'sendMessage' ? ++messageId : payload.message_id
        return deliver({ message_id: call.responseMessageId })
      }
      deliver(true)
    }
    return request
  }
  const host = {
    calls, forbidden, listRequests, projectionRequests,
    state: async () => JSON.parse(await readFile(statePath, 'utf8')),
    creates: () => calls.filter(call => call.method === 'createForumTopic'),
    revokeOwner() { allowedUsers.splice(0, allowedUsers.length, '99') },
    async feed(...updates) {
      assert.equal(feeding, false, 'synthetic incoming batches must be fully serialized')
      feeding = true
      try {
        const before = polls, deliver = pendingPoll
        pendingPoll = undefined
        assert.ok(deliver, 'a native long poll must be waiting')
        deliver(updates)
        await until(() => polls > before && pendingPoll, 'next native long poll after handlers finish')
      } finally { feeding = false }
    },
    watchEvent(seq) {
      emitter.emit('session/event', agent.session, { seq, type: 'turn/start', data: { turn: seq } })
    },
    async latchWatcher() {
      // Turn-start asks the real watcher to open the original ordinary session.
      // The legacy unknown-outcome latch refuses it, producing bindingErrors.
      emitter.emit('session/event', agent.session, { seq: 1, type: 'turn/start', data: { turn: 1 } })
      await until(async () => (await host.state()).watch.bindingErrors[watchKey], 'native watch error latch persisted')
    },
    async cleanup() {
      try { for (const fn of cleanups) await fn?.() }
      finally {
        https.request = originalRequest
        if (previousHome === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previousHome
        if (previousNodeEnv === undefined) delete process.env.NODE_ENV
        else process.env.NODE_ENV = previousNodeEnv
        await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
      }
    },
  }
  try {
    const { apply } = await import(`../index.js?recoveryHome=${encodeURIComponent(home)}`)
    apply(ctx, { enabled: true, tokenRef: 'SYNTHETIC_RECOVERY_REFERENCE', allowedUsers,
      allowedChats: ['100'], cwd: workspace.path, language: 'en', showThinking: false })
    await until(() => pendingPoll, 'initial native long poll')
    await host.feed(message(1, '/watch all'))
    return host
  } catch (error) { await host.cleanup(); throw error }
}

function preserved(state) {
  assert.deepEqual(state.sessions[unrelated.sessionId], unrelated, 'unrelated existing mapping preserved byte-for-byte')
  assert.equal(state.threads['200:8001'], unrelated.sessionId)
}
function noNativeMutation(host) {
  assert.deepEqual(host.forbidden, { create: 0, fork: 0, prompt: 0 })
  assert.ok(host.listRequests.length > 0, 'native list API actually exercised')
}
function oneOriginalMapping(state) {
  const mappings = Object.values(state.sessions).filter(record => record.sessionId === sid)
  assert.equal(mappings.length, 1, 'exactly one mapping for the same original session')
  assert.equal(mappings[0].threadId, 7001)
  assert.equal(mappings[0].chatId, 100)
  assert.equal(state.threads['100:7001'], sid)
  assert.equal(state.topicAttempts[attemptKey], undefined)
  preserved(state)
}

test('native Host s: definitive Topics rejection releases pending and the next s: retries once', async () => {
  const host = await scenario('rejected')
  try {
    await host.feed(callback(2, `s:${sid}`))
    let state = await host.state()
    assert.equal(host.creates().length, 1)
    assert.equal(state.topicAttempts[attemptKey], undefined,
      'requestOnce error_code survives the human setup hint and releases the attempt')
    assert.equal(Object.values(state.sessions).some(record => record.sessionId === sid), false)
    assert.ok(host.calls.some(call => /Enable Threaded mode/.test(call.body.text ?? '')), 'handler returns the wrapped setup hint')
    preserved(state)
    await host.feed(callback(3, `s:${sid}`))
    assert.equal(host.creates().length, 2, 'one rejected request and one successful retry')
    state = await host.state()
    oneOriginalMapping(state)
    assert.ok(host.projectionRequests.length > 0, 'original session native history projection exercised')
    noNativeMutation(host)
  } finally { await host.cleanup() }
})

test('native Host unknown outcome requires /retry confirmation; r: clears both latches without replacing a session', async () => {
  const host = await scenario('unknown')
  try {
    await host.feed(callback(2, `s:${sid}`))
    assert.equal((await host.state()).topicAttempts[attemptKey], 'pending')
    await host.feed(callback(3, `s:${sid}`))
    assert.equal(host.creates().length, 1, 'ordinary open cannot repeat an unknown create')
    await host.latchWatcher()
    const pending = await host.state()
    assert.ok(pending.watch.bindingErrors[watchKey])
    await host.feed(message(4, `/retry ${sid}`))
    const confirmation = host.calls.find(call => buttons(call).some(button => button.callback_data === `r:${sid}`))
    assert.ok(confirmation, 'real /retry handler offers explicit missing-topic confirmation')
    assert.match(confirmation.body.text, /\/bind/)
    let state = await host.state()
    assert.equal(host.creates().length, 1, '/retry itself must never create')
    assert.equal(state.topicAttempts[attemptKey], 'pending', '/retry itself must not clear legacy pending')
    assert.deepEqual(state.watch.bindingErrors[watchKey], pending.watch.bindingErrors[watchKey], '/retry itself must not clear watcher latch')
    const callbackData = buttons(confirmation).find(button => button.callback_data === `r:${sid}`).callback_data
    await host.feed(callback(5, callbackData))
    assert.equal(host.creates().length, 2, 'trusted confirmation permits exactly one fresh attempt')
    host.watchEvent(2)
    await until(async () => (await host.state()).watch.bindings[watchKey]?.threadId === 7001,
      'native watcher reuses confirmed original-session binding on the next Host event')
    state = await host.state()
    oneOriginalMapping(state)
    assert.equal(state.watch.bindingErrors[watchKey], undefined, 'actual r: handler clears watch latch')
    assert.equal(state.watches['100'].bindingErrors[watchKey], undefined)
    const bound = structuredClone(state.sessions[sid])
    await host.feed(callback(6, callbackData))
    assert.equal(host.creates().length, 2, 'repeated confirmation cannot recreate topic')
    state = await host.state()
    assert.deepEqual(state.sessions[sid], bound, 'repeated confirmation cannot rebind existing topic')
    oneOriginalMapping(state)
    noNativeMutation(host)
  } finally { await host.cleanup() }
})

test('native Host unauthorized callback and revoked owner cannot clear pending recovery', async () => {
  const host = await scenario('unknown')
  try {
    await host.feed(callback(2, `s:${sid}`))
    await host.latchWatcher()
    await host.feed(message(3, `/retry ${sid}`))
    const confirmation = host.calls.find(call => buttons(call).some(button => button.callback_data === `r:${sid}`))
    assert.ok(confirmation)
    const callbackData = buttons(confirmation)[0].callback_data
    const pending = await host.state()
    await host.feed(callback(4, callbackData, 99))
    let state = await host.state()
    assert.equal(state.topicAttempts[attemptKey], 'pending')
    assert.deepEqual(state.watch.bindingErrors, pending.watch.bindingErrors)
    assert.deepEqual(state.sessions, pending.sessions)
    assert.equal(host.creates().length, 1)
    host.revokeOwner()
    await host.feed(callback(5, callbackData, 42))
    state = await host.state()
    assert.equal(state.topicAttempts[attemptKey], 'pending', 'revoked owner cannot clear legacy latch')
    assert.deepEqual(state.watch.bindingErrors, pending.watch.bindingErrors, 'revoked owner cannot clear watcher latch')
    assert.deepEqual(state.sessions, pending.sessions)
    assert.equal(host.creates().length, 1)
    preserved(state)
    noNativeMutation(host)
  } finally { await host.cleanup() }
})
