import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import https from 'node:https'
import test from 'node:test'

async function until(predicate, description) {
  const deadline = Date.now() + 2500
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`)
    await new Promise(setImmediate)
  }
}
const buttons = call => call.body.reply_markup?.inline_keyboard?.flat() ?? []
const message = (id, text) => ({ update_id: id, message: {
  message_id: id, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, text,
} })
const callback = (id, data, messageId) => ({ update_id: id, callback_query: {
  id: `synthetic-callback-${id}`, from: { id: 42 }, data,
  message: { message_id: messageId, chat: { id: 100, type: 'private' }, message_thread_id: 7001 },
} })

// Independent fixture: importing another test file would register its tests twice.
async function scenario() {
  const home = await mkdtemp(join(tmpdir(), 'telegram-mirrored-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const emitter = new EventEmitter(), cleanups = [], calls = []
  const workspace = { id: 'synthetic-workspace', path: '/tmp/synthetic-mirror', title: 'Synthetic', sessionIds: ['web'] }
  const agent = { session: { id: 'session-web', header: { cwd: workspace.path } } }
  const controller = {
    async list(options) { assert.deepEqual(options, {}); return { items: [{ sessionId: agent.session.id, blank: false, running: false }] } },
    async resolveAgent(id) { assert.equal(id, agent.session.id); return { agent } },
  }
  const registry = { list: () => [workspace], archivedSessionIds: [] }
  const services = {
    sessionController: controller, workspaceRegistry: registry,
    credentials: { resolve: async () => ({ value: [String(123456789), 'SYNTHETIC_MIRROR_TEST_'.repeat(2)].join(':') }) },
    agents: { get: id => id === agent.session.id ? agent : undefined },
    sessionQuery: {
      readTitleSnapshot: async () => ({ title: { title: 'Synthetic Web session' } }),
      readSurface: async () => ({ events: [] }), readSession: async () => ({ events: [] }),
    },
  }
  const ctx = {
    sessionController: controller, workspaceRegistry: registry, get: name => services[name],
    on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn) },
    effect(fn) { cleanups.push(fn()) }, logger: { info() {}, warn() {} },
  }
  let pendingPoll, polls = 0, messageId = 0
  const originalRequest = https.request
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
      const call = { method, body: payload }
      calls.push(call)
      if (method === 'getUpdates') { polls++; pendingPoll = deliver; return }
      if (method === 'getMe') return deliver({ id: 1, username: 'syntheticbot' })
      if (method === 'createForumTopic') return deliver({ message_thread_id: 7001 })
      if (method === 'sendMessage' || method === 'editMessageText') {
        call.responseMessageId = method === 'sendMessage' ? ++messageId : payload.message_id
        return deliver({ message_id: call.responseMessageId })
      }
      deliver(true)
    }
    return request
  }
  const { apply } = await import(`../index.js?mirrorHome=${encodeURIComponent(home)}`)
  apply(ctx, { enabled: true, tokenRef: 'SYNTHETIC_TOKEN', allowedUsers: ['42'], allowedChats: ['100'], cwd: workspace.path, language: 'en', showThinking: false })
  await until(() => pendingPoll, 'initial long poll')
  const host = {
    calls,
    async feed(...updates) {
      const before = polls, deliver = pendingPoll
      pendingPoll = undefined
      assert.ok(deliver)
      deliver(updates)
      await until(() => polls > before && pendingPoll, 'next long poll')
    },
    request(type, data, nativeNext) {
      const listeners = emitter.listeners(type)
      assert.equal(listeners.length, 1, 'one Host middleware handles the event')
      const req = { agent, ...data }
      return { req, promise: Promise.resolve(listeners[0](req, (...args) => {
        assert.equal(args.length, 0, 'native next() takes no replacement request')
        return nativeNext(req)
      })) }
    },
    async cleanup() {
      for (const fn of cleanups) await fn?.()
      https.request = originalRequest
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
    },
  }
  await host.feed(message(1, '/watch all'))
  emitter.emit('session/event', agent.session, { seq: 1, type: 'turn/start', data: { turn: 1 } })
  await until(async () => {
    try {
      const state = JSON.parse(await readFile(join(home, 'telegram-workain/state.json'), 'utf8'))
      return state.watch.sessions['session-web']?.cursor >= 1
    } catch { return false }
  }, 'bound Web topic persisted')
  return host
}

function webProvider() {
  let resolve
  const pending = new Promise(done => { resolve = done })
  return {
    calls: 0, request: undefined, signal: undefined, closed: false,
    next(req) {
      this.calls++
      this.request = req
      // Capture the real alias during native next(), before middleware restores req.signal.
      this.signal = req.signal
      this.signal.addEventListener('abort', () => {
        this.closed = true
        resolve(undefined)
      }, { once: true })
      return pending
    },
    answer(value) { resolve(value) },
  }
}
const cases = [
  { name: 'approval', type: 'approval/request', prefix: 'a:y:', data: { toolName: 'bash', reason: 'Synthetic mirrored approval' }, webAnswer: 'rejected', tgAnswer: 'allowed-once' },
  { name: 'questions', type: 'user-questions/request', prefix: 'q:', data: { questions: [{ id: 'choice', question: 'Synthetic mirrored question', options: [{ label: 'Yes' }, { label: 'No' }] }] }, webAnswer: { answers: [{ id: 'choice', selected: ['No'] }] }, tgAnswer: { answers: [{ id: 'choice', selected: ['Yes'] }] } },
]
async function telegramPrompt(host, prefix) {
  let prompt
  await until(() => {
    prompt = host.calls.find(call => call.method === 'sendMessage' && buttons(call).some(button => button.callback_data.startsWith(prefix)))
    return prompt
  }, 'Telegram provider visible for same Host event')
  await new Promise(setImmediate) // HTTPS reply installs the pending callback record.
  assert.equal(prompt.body.message_thread_id, 7001)
  return prompt
}

for (const item of cases) {
  test(`mirrored Host ${item.name}: Web-first closes Telegram keyboard and ignores stale callback`, async () => {
    const host = await scenario()
    try {
      const original = new AbortController(), web = webProvider()
      const { req, promise } = host.request(item.type, { ...item.data, signal: original.signal }, req => web.next(req))
      assert.equal(web.calls, 1, 'Web provider dispatched by the original Host event immediately')
      assert.equal(web.request, req, 'native next sees the exact Host request, not a clone')
      assert.notEqual(web.signal, original.signal)
      const prompt = await telegramPrompt(host, item.prefix)
      assert.equal(web.closed, false, 'both providers remain visible before an answer')
      const oldCallback = buttons(prompt).find(button => button.callback_data.startsWith(item.prefix)).callback_data
      web.answer(item.webAnswer)
      const answer = await promise
      assert.deepEqual(answer, item.webAnswer, 'actual Host result is the first Web answer')
      await until(() => host.calls.some(call => call.method === 'editMessageText'
        && call.body.message_id === prompt.responseMessageId
        && buttons(call).length === 0 && /Answered in Web/.test(call.body.text)), 'old Telegram keyboard removed and closed as answered in Web')
      await host.feed(callback(2, oldCallback, prompt.responseMessageId))
      assert.deepEqual(await promise, item.webAnswer, 'stale Telegram answer cannot replace the Host result')
      assert.equal(web.calls, 1, 'Telegram callback never re-enters native next')
      assert.equal(original.signal.aborted, false)
      assert.equal(web.signal.aborted, false, 'winning Web provider is not cancelled')
    } finally { await host.cleanup() }
  })

  test(`mirrored Host ${item.name}: Telegram-first closes native Web signal without aborting caller`, async () => {
    const host = await scenario()
    try {
      const original = new AbortController(), web = webProvider()
      const { req, promise } = host.request(item.type, { ...item.data, signal: original.signal }, req => web.next(req))
      assert.equal(web.calls, 1)
      assert.equal(web.request, req)
      const webSignal = web.signal
      assert.notEqual(webSignal, original.signal)
      const prompt = await telegramPrompt(host, item.prefix)
      assert.equal(web.closed, false, 'Web and Telegram are both pending for this Host request')
      const callbackData = buttons(prompt).find(button => button.callback_data.startsWith(item.prefix)).callback_data
      await host.feed(callback(2, callbackData, prompt.responseMessageId))
      assert.deepEqual(await promise, item.tgAnswer, 'Telegram resolves the actual Host interaction')
      assert.equal(web.closed, true, 'native Web provider observes its captured signal close')
      assert.equal(webSignal.aborted, true)
      assert.deepEqual(webSignal.reason, { code: 'MIRROR_SETTLED', channel: 'telegram' })
      assert.equal(original.signal.aborted, false, 'caller/agent signal is not the losing provider signal')
      assert.equal(web.calls, 1, 'native next is invoked once, never as Telegram fallback')
      web.answer(item.webAnswer)
      assert.deepEqual(await promise, item.tgAnswer, 'late Web completion cannot replace Telegram result')
    } finally { await host.cleanup() }
  })
}
