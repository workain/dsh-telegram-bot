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

// Constructed synthetic Bot API token, never an actual credential.
const botFixture = [String(123456789), 'SYNTHETIC_TEST_ONLY_'.repeat(2)].join(':')
const update = (id, text, thread = 1) => ({
  update_id: id,
  message: { message_id: id, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, message_thread_id: thread, text },
})

async function hostScenario(allowedUsers = ['42']) {
  const home = await mkdtemp(join(tmpdir(), 'telegram-host-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const emitter = new EventEmitter()
  const calls = [], prompts = [], creates = [], logs = [], cleanups = [], mutations = []
  const workspace = { id: 'registered', path: '/tmp/default-workspace', title: 'Registered', sessionIds: ['web', 'archived', 'child', 'parented', 'delegated'] }
  const rows = [
    { sessionId: 'session-web', blank: false, running: false },
    { sessionId: 'session-archived', blank: false, running: false },
    { sessionId: 'session-child', blank: false, running: false, origin: 'subagent' },
    { sessionId: 'session-parented', blank: false, running: false, parentSessionId: 'session-web' },
    { sessionId: 'session-delegated', blank: false, running: false, delegationDepth: 1 },
    { sessionId: 'session-orphan', blank: false, running: false },
  ]
  const agents = new Map()
  const controller = {
    async list(options) { assert.deepEqual(options, {}); return { items: rows } },
    async selectModel(request) { mutations.push(['model', request]); return { selected: request } },
    async create(options) {
      assert.equal(options.workspaceId, workspace.id)
      creates.push(options)
      return { sessionId: 'session-created' }
    },
    async resolveAgent(id) {
      assert.ok(rows.some(row => row.sessionId === id))
      if (!agents.has(id)) agents.set(id, { session: { id, header: { cwd: workspace.path }, append(...args) { mutations.push(['append', ...args]) } }, inbox: { clear() { mutations.push(['clear']) } }, cancel(...args) { mutations.push(['cancel', ...args]) } })
      return { agent: agents.get(id) }
    },
    async prompt(request) {
      assert.equal(request.mode, 'queue')
      assert.match(request.requestId, /^telegram:100:\d+$/)
      prompts.push(structuredClone(request))
      // Admission returns without completing a model turn. Both messages must
      // enter the native queue while the Web turn remains active.
      return { accepted: true }
    },
  }
  const registry = { list: () => [workspace], archivedSessionIds: ['archived'] }
  const services = {
    sessionController: controller, workspaceRegistry: registry,
    credentials: { resolve: async () => ({ value: botFixture }) },
    agents: { get: id => agents.get(id) },
    permissionPresets: { current: () => 'workspace-write', set: (...args) => mutations.push(['permission', ...args]) },
    sessionQuery: {
      readTitleSnapshot: async () => ({ title: { title: 'Web session' } }),
      readSurface: async () => ({ events: [] }), readSession: async () => ({ events: [] }),
    },
  }
  const ctx = {
    sessionController: controller, workspaceRegistry: registry,
    get: name => services[name],
    on(name, fn) { emitter.on(name, fn); return () => emitter.off(name, fn) },
    effect(fn) { cleanups.push(fn()) },
    logger: { info: text => logs.push(text), warn: text => logs.push(text) },
  }
  let pendingPoll, polls = 0, messageId = 0, topicId = 7000
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
      calls.push({ method, body: payload })
      if (method === 'getUpdates') { polls++; pendingPoll = deliver; return }
      if (method === 'getMe') return deliver({ id: 1, username: 'testbot' })
      if (method === 'createForumTopic') return deliver({ message_thread_id: ++topicId })
      if (method === 'sendMessage' || method === 'editMessageText') return deliver({ message_id: ++messageId })
      deliver(true)
    }
    return request
  }
  const { apply } = await import(`../index.js?home=${encodeURIComponent(home)}`)
  const config = { enabled: true, tokenRef: 'TEST_TOKEN', allowedUsers, allowedChats: ['100'], cwd: workspace.path, language: 'en', showThinking: false }
  apply(ctx, config)
  await until(() => pendingPoll, 'initial long poll')
  return {
    calls, prompts, creates, rows, workspace, logs, config, mutations, controller,
    async request(type, data, nativeNext = () => 'downstream') {
      const sessionId = typeof nativeNext === 'string' ? nativeNext : 'session-web'
      const provider = typeof nativeNext === 'function' ? nativeNext : () => 'downstream'
      const { agent } = await controller.resolveAgent(sessionId)
      const listeners = emitter.listeners(type)
      assert.equal(listeners.length, 1, `${type} has one Host handler`)
      const req = { agent, ...data }
      return listeners[0](req, (...args) => {
        assert.equal(args.length, 0, 'Cordis next captures the exact request without arguments')
        return provider(req)
      })
    },
    async restart() {
      for (const fn of cleanups.splice(0)) await fn?.()
      emitter.removeAllListeners() // Cordis disposes scope-owned handlers.
      pendingPoll = undefined
      apply(ctx, config)
      await until(() => pendingPoll, 'restarted long poll')
    },
    async feed(...updates) {
      const before = polls
      const deliver = pendingPoll; pendingPoll = undefined
      assert.ok(deliver, 'feed only while long poll is waiting')
      deliver(updates)
      await until(() => polls > before && pendingPoll, 'updates admitted and next long poll')
    },
    emit(id, seq, type, data, header = {}) {
      emitter.emit('session/event', { id, header: { cwd: workspace.path, ...header } }, { seq, type, data })
    },
    async cursor(id, seq) {
      await until(async () => {
        try {
          const state = JSON.parse(await readFile(join(home, 'telegram-workain/state.json'), 'utf8'))
          return state.watch.sessions[id]?.cursor >= seq
        } catch { return false }
      }, `durable cursor ${id}:${seq}`)
    },
    async cleanup() {
      for (const fn of cleanups) await fn?.()
      https.request = originalRequest
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
    },
  }
}

const sent = scenario => scenario.calls.filter(call => call.method === 'sendMessage')
const callback = (id, data) => ({ update_id: id, callback_query: {
  id: `callback-${id}`, from: { id: 42 }, data,
  message: { message_id: id, chat: { id: 100, type: 'private' }, message_thread_id: 7001 },
} })
const buttons = call => call.body.reply_markup?.inline_keyboard?.flat() ?? []
async function bindWeb(host) {
  await host.feed(update(1, '/watch all'))
  host.emit('session-web', 1, 'turn/start', { turn: 1 })
  await host.cursor('session-web', 1)
}
function tracked(promise) {
  const state = { settled: false }
  state.promise = promise.then(value => { state.settled = true; state.value = value }, error => { state.settled = true; state.error = error })
  return state
}
async function keyboard(host, prefix, after = 0) {
  let result
  await until(() => {
    result = sent(host).slice(after).find(call => buttons(call).some(button => button.callback_data.startsWith(prefix)))
    return result
  }, `Host ${prefix} keyboard`)
  assert.equal(result.body.message_thread_id, 7001)
  // Let the mocked HTTPS response install the pending approval record.
  await new Promise(setImmediate)
  return result
}

test('watch all and watch here release questions owned by the previous generation', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    let id = 2
    for (const command of ['/watch all', '/watch here']) {
      const offset = sent(host).length
      const question = tracked(host.request('user-questions/request', { questions: [{ id: 'generation', question: `Question before ${command}`, options: [{ label: 'Yes' }] }], signal: new AbortController().signal }))
      await keyboard(host, 'q:', offset)
      await host.feed(update(id++, command, 7001))
      await until(() => question.settled, `${command} releases old question`)
      assert.ok(question.error, 'generation change must reject rather than leave the Web request hung')
      assert.equal(question.value, undefined)
    }
  } finally { await host.cleanup() }
})

test('delayed Host interaction admission cannot cross watch off/on generations', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    let id = 2
    for (const type of ['approval/request', 'user-questions/request']) {
      let entered = false, release
      const waiting = new Promise(resolve => { release = resolve })
      const originalList = host.controller.list
      host.controller.list = (...args) => {
        // Only the old interaction is delayed; /watch admission remains live.
        host.controller.list = originalList
        entered = true
        return waiting.then(() => originalList(...args))
      }
      const offset = sent(host).length
      const original = new AbortController()
      let webRequest, answerWeb, nativeCalls = 0, listFinished = false
      const request = tracked(host.request(type, {
        toolName: 'bash', reason: 'Stale admission',
        questions: [{ id: 'old', question: 'Stale question', options: [{ label: 'Yes' }] }],
        signal: original.signal,
      }, req => {
        nativeCalls++
        webRequest = req
        assert.equal(listFinished, false, 'Web dispatch does not wait for Telegram admission')
        return new Promise(resolve => { answerWeb = resolve })
      }))
      await until(() => entered, 'questionChat ordinary-session check blocked in native list')
      assert.equal(nativeCalls, 1, 'native Web provider is already visible while list is held')
      const webSignal = webRequest.signal
      assert.notEqual(webSignal, original.signal, 'capture the actual native provider signal alias')
      await host.feed(update(id++, '/watch off'), update(id++, '/watch on'))
      release()
      // Await the held list continuation and its admission check, not a timeout.
      await waiting
      await new Promise(setImmediate)
      listFinished = true
      assert.equal(request.settled, false, 'invalidating Telegram does not discard the pending Web answer')
      assert.equal(webSignal.aborted, false, 'native Web request remains answerable after off/on')
      const expected = type === 'approval/request' ? 'allowed-once' : { answers: [{ id: 'old', selected: ['Yes'] }] }
      answerWeb(expected)
      await request.promise
      assert.equal(request.error, undefined)
      assert.deepEqual(request.value, expected, 'legitimate native answer settles the original Host request')
      assert.equal(nativeCalls, 1)
      assert.equal(original.signal.aborted, false)
      assert.ok(sent(host).slice(offset).every(call => !buttons(call).some(button => /^(?:a:|q:)/.test(button.callback_data))), 'no old Allow/Question keyboard reaches the new generation')
    }
  } finally { await host.cleanup() }
})

test('conflicting bind cannot relabel replies approvals or move an existing session topic', async () => {
  const host = await hostScenario()
  try {
    host.rows.push({ sessionId: 'session-other', blank: false, running: false })
    host.workspace.sessionIds.push('other')
    await bindWeb(host)
    const approval = tracked(host.request('approval/request', { toolName: 'bash', reason: 'Original Web agent operation', signal: new AbortController().signal }))
    const prompt = await keyboard(host, 'a:')
    assert.match(prompt.body.text, /session-web/)
    assert.doesNotMatch(prompt.body.text, /session-other/)
    await host.feed(update(2, '/bind session-other', 7001))
    assert.ok(sent(host).some(call => call.body.message_thread_id === 7001 && /Перенос привязок.*запрещён/.test(call.body.text)), 'conflict must explain that identity moves are forbidden')
    assert.equal(approval.settled, false, 'rejected rebind must not replace the original request')
    await host.feed(callback(3, buttons(prompt).find(button => button.callback_data.startsWith('a:y:')).callback_data))
    await until(() => approval.settled, 'original approval callback')
    assert.equal(approval.value, 'allowed-once')
    const beforeOther = sent(host).length
    assert.equal(await host.request('approval/request', { toolName: 'write', reason: 'Unbound other agent', signal: new AbortController().signal }, 'session-other'), 'downstream')
    assert.equal(sent(host).length, beforeOther, 'unbound other agent cannot impersonate the Web topic')
    await host.feed(update(4, 'still original', 7001), update(5, '/bind session-web', 7999))
    assert.deepEqual(host.prompts, [{ sessionId: 'session-web', requestId: 'telegram:100:4', mode: 'queue', content: [{ type: 'text', text: 'still original' }] }])
    assert.ok(sent(host).some(call => call.body.message_thread_id === 7999 && /Перенос привязок.*запрещён/.test(call.body.text)), 'existing session cannot move into a free topic')
    host.emit('session-web', 2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'original routed answer' }] } })
    host.emit('session-web', 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await host.cursor('session-web', 3)
    assert.equal(sent(host).find(call => call.body.text.includes('original routed answer')).body.message_thread_id, 7001)
    assert.equal(host.calls.filter(call => call.method === 'createForumTopic').length, 1)
    assert.equal(host.creates.length, 0)
  } finally { await host.cleanup() }
})

test('watch off releases Telegram-owned interactions without cancelling the native agent', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    const approval = tracked(host.request('approval/request', { toolName: 'bash', reason: 'Pending before watch off', signal: new AbortController().signal }))
    const oldApproval = await keyboard(host, 'a:')
    const question = tracked(host.request('user-questions/request', { questions: [{ id: 'pause', question: 'Pause question', options: [{ label: 'Yes' }] }], signal: new AbortController().signal }))
    const oldQuestion = await keyboard(host, 'q:')
    await host.feed(update(2, '/watch off'))
    await until(() => approval.settled && question.settled, 'watch off releases pending requests')
    assert.equal(approval.value, 'unavailable')
    assert.ok(question.error, 'question must reject so Web can reopen it')
    assert.deepEqual(host.mutations, [], '/watch off must not cancel the native agent')
    await host.feed(callback(3, buttons(oldApproval).find(button => button.callback_data.startsWith('a:y:')).callback_data), callback(4, buttons(oldQuestion)[0].callback_data))
    assert.equal(approval.value, 'unavailable', 'stale allow callback cannot resurrect a released request')
    assert.equal(question.value, undefined)
    assert.deepEqual(host.mutations, [])
  } finally { await host.cleanup() }
})

test('runtime disposal releases pending Host interactions and isolates stale callbacks from the next run', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    const approval = tracked(host.request('approval/request', { toolName: 'bash', reason: 'Pending at disposal', signal: new AbortController().signal }))
    const oldApproval = await keyboard(host, 'a:')
    const question = tracked(host.request('user-questions/request', { questions: [{ id: 'dispose', question: 'Pending question', options: [{ label: 'Yes' }] }], signal: new AbortController().signal }))
    const oldQuestion = await keyboard(host, 'q:')
    await host.restart() // Disposes the original plugin scope before reapplying.
    await until(() => approval.settled && question.settled, 'disposed Host requests released')
    assert.equal(approval.value, 'unavailable')
    assert.match(question.error?.message ?? '', /Telegram runtime stopped/)
    const offset = sent(host).length
    const nextApproval = tracked(host.request('approval/request', { toolName: 'write', reason: 'New runtime request', signal: new AbortController().signal }))
    const freshApproval = await keyboard(host, 'a:', offset)
    const nextQuestion = tracked(host.request('user-questions/request', { questions: [{ id: 'next', question: 'New question', options: [{ label: 'Yes' }] }], signal: new AbortController().signal }))
    const freshQuestion = await keyboard(host, 'q:', offset)
    await host.feed(callback(2, buttons(oldApproval).find(button => button.callback_data.startsWith('a:y:')).callback_data), callback(3, buttons(oldQuestion)[0].callback_data))
    assert.equal(nextApproval.settled, false)
    assert.equal(nextQuestion.settled, false)
    await host.feed(callback(4, buttons(freshApproval).find(button => button.callback_data.startsWith('a:y:')).callback_data), callback(5, buttons(freshQuestion)[0].callback_data))
    await until(() => nextApproval.settled && nextQuestion.settled, 'fresh callbacks resolve current requests')
    assert.equal(nextApproval.value, 'allowed-once')
    assert.deepEqual(nextQuestion.value, { answers: [{ id: 'next', selected: ['Yes'] }] })
  } finally { await host.cleanup() }
})

test('Host approval cancellation rejects stale callback without settling the next request', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    const abort = new AbortController()
    const first = tracked(host.request('approval/request', { toolName: 'bash', reason: 'Confirm first operation', signal: abort.signal }))
    const oldPrompt = await keyboard(host, 'a:')
    const oldAllow = buttons(oldPrompt).find(button => button.callback_data.startsWith('a:y:')).callback_data
    abort.abort()
    await first.promise
    assert.equal(first.value, 'cancelled')
    const offset = sent(host).length
    const second = tracked(host.request('approval/request', { toolName: 'write', reason: 'Confirm next operation', signal: new AbortController().signal }))
    const nextPrompt = await keyboard(host, 'a:', offset)
    await host.feed(callback(2, oldAllow))
    assert.equal(second.settled, false, 'stale approval identity must not allow a later tool')
    await host.feed(callback(3, buttons(nextPrompt).find(button => button.callback_data.startsWith('a:y:')).callback_data))
    await second.promise
    assert.equal(second.value, 'allowed-once')
  } finally { await host.cleanup() }
})

test('Host question callbacks are request-scoped and /stop is not swallowed as a free-text answer', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    const question = { id: 'choice', question: 'Choose a safe option', options: [{ label: 'Yes' }] }
    const abort = new AbortController()
    const first = tracked(host.request('user-questions/request', { questions: [question], signal: abort.signal }))
    const oldPrompt = await keyboard(host, 'q:')
    abort.abort(new Error('cancelled first question'))
    await first.promise
    assert.match(first.error.message, /cancelled first/)
    const offset = sent(host).length
    const second = tracked(host.request('user-questions/request', { questions: [question], signal: new AbortController().signal }))
    const nextPrompt = await keyboard(host, 'q:', offset)
    await host.feed(callback(2, buttons(oldPrompt)[0].callback_data))
    assert.equal(second.settled, false)
    await host.feed(callback(3, buttons(nextPrompt)[0].callback_data))
    await second.promise
    assert.deepEqual(second.value, { answers: [{ id: 'choice', selected: ['Yes'] }] })
    const free = tracked(host.request('user-questions/request', { questions: [{ id: 'free', question: 'Describe your choice' }], signal: new AbortController().signal }))
    await until(() => sent(host).some(call => call.body.text.includes('Describe your choice')), 'free-text question')
    await host.feed(update(4, '/stop', 7001))
    await free.promise
    assert.ok(free.error, '/stop must cancel, not answer, the question')
    assert.ok(sent(host).some(call => call.body.text.includes('Stop requested')))
    assert.equal(host.prompts.length, 0)
  } finally { await host.cleanup() }
})

test('revoking owner blocks pending approval callbacks and further watched output', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    const abort = new AbortController()
    const approval = tracked(host.request('approval/request', { toolName: 'bash', reason: 'Revocable operation', signal: abort.signal }))
    const prompt = await keyboard(host, 'a:')
    host.config.allowedUsers = []
    const before = sent(host).length
    await host.feed(callback(2, buttons(prompt).find(button => button.callback_data.startsWith('a:y:')).callback_data))
    assert.equal(approval.settled, false, 'revoked owner cannot approve a pending request')
    host.emit('session-web', 2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'revoked private answer' }] } })
    host.emit('session-web', 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await host.feed(update(3, '/ping'))
    assert.equal(sent(host).length, before, 'revoked owner receives no pending/session text')
    abort.abort()
    await approval.promise
    assert.equal(approval.value, 'cancelled')
  } finally { await host.cleanup() }
})

test('restart retains topic and durable event cursor without replaying prior output', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    host.emit('session-web', 2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'before restart' }] } })
    host.emit('session-web', 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await host.cursor('session-web', 3)
    await host.restart()
    const before = sent(host).length
    host.emit('session-web', 2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'before restart' }] } })
    host.emit('session-web', 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    host.emit('session-web', 4, 'turn/start', { turn: 2 })
    await host.cursor('session-web', 4)
    assert.equal(sent(host).length, before, 'durable sequence prevents replay')
    host.emit('session-web', 5, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'after restart' }] } })
    host.emit('session-web', 6, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
    await host.cursor('session-web', 6)
    assert.equal(host.calls.filter(call => call.method === 'createForumTopic').length, 1)
    assert.equal(sent(host).find(call => call.body.text.includes('after restart')).body.message_thread_id, 7001)
  } finally { await host.cleanup() }
})

test('Host Web events route to watched topic; native queued prompts deduplicate; watch off revokes delivery', async () => {
  const host = await hostScenario()
  host.config.showToolCalls = true // Explicit opt-in; ordinary deployments keep tool notices off.
  try {
    await host.feed(update(1, '/watch all'))
    host.emit('session-web', 10, 'turn/start', { turn: 3, source: 'web' })
    host.emit('session-web', 11, 'tool/call', { turn: 3, name: 'read', callId: 'call-1', arguments: { file_path: 'safe.txt' } })
    await until(() => sent(host).some(call => call.body.text === 'Tool: read'), 'Web tool progress')
    const topic = host.calls.find(call => call.method === 'createForumTopic')
    assert.ok(topic)
    const progress = sent(host).find(call => call.body.text === 'Tool: read')
    assert.equal(progress.body.chat_id, 100)
    assert.equal(progress.body.message_thread_id, 7001)

    await host.feed(update(2, 'first queued', 7001), update(3, 'second queued', 7001))
    assert.deepEqual(host.prompts.map(request => ({ sessionId: request.sessionId, requestId: request.requestId, mode: request.mode, content: request.content })), [
      { sessionId: 'session-web', requestId: 'telegram:100:2', mode: 'queue', content: [{ type: 'text', text: 'first queued' }] },
      { sessionId: 'session-web', requestId: 'telegram:100:3', mode: 'queue', content: [{ type: 'text', text: 'second queued' }] },
    ])
    assert.equal(host.creates.length, 0, 'binding an existing Web session must not create one')
    await host.feed(update(2, 'first queued', 7001), update(3, 'second queued', 7001))
    assert.equal(host.prompts.length, 2, 'duplicate Telegram updates never reach native admission twice')

    host.emit('session-web', 12, 'assistant/message', { turn: 3, message: { role: 'assistant', content: [{ type: 'text', text: `Web answer ${botFixture}` }] } })
    await until(() => sent(host).some(call => call.body.text.includes('Web answer')), 'committed assistant answer mirrored before turn/end')
    const answer = sent(host).find(call => call.body.text.includes('Web answer'))
    assert.match(answer.body.text, /^🤖 /)
    assert.equal(answer.body.message_thread_id, 7001)
    host.emit('session-web', 13, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
    await host.cursor('session-web', 13)
    await until(() => sent(host).some(call => /Turn 3: completed/.test(call.body.text)), 'separate native turn completion status')
    const completion = sent(host).find(call => /Turn 3: completed/.test(call.body.text))
    assert.notEqual(completion, answer, 'turn status is separate from the committed answer')
    assert.equal(completion.body.message_thread_id, 7001)
    assert.doesNotMatch(completion.body.text, /Web answer/, 'turn/end does not duplicate the mirrored answer')
    assert.equal(sent(host).filter(call => call.body.text.includes('Web answer')).length, 1)
    assert.match(answer.body.text, /\[REDACTED\]/)
    assert.ok(sent(host).every(call => !call.body.text.includes(botFixture)), 'bot token is never outbound text')
    const count = sent(host).length
    host.emit('session-web', 13, 'turn/end', { turn: 3, reason: { kind: 'completed' } })
    // A subsequent sequenced event provides a durable barrier for dedup work.
    host.emit('session-web', 14, 'turn/start', { turn: 4 })
    await host.cursor('session-web', 14)
    assert.equal(sent(host).length, count)

    await host.feed(update(4, '/watch off'))
    const afterOff = sent(host).length
    host.emit('session-web', 15, 'assistant/message', { turn: 4, message: { content: [{ type: 'text', text: 'must stay private' }] } })
    host.emit('session-web', 16, 'turn/end', { turn: 4, reason: { kind: 'completed' } })
    // Re-enable only after an independent queued command has completed. Policy
    // is checked synchronously on receipt and again before sending.
    await host.feed(update(5, '/ping'))
    assert.equal(sent(host).filter(call => call.body.text.includes('must stay private')).length, 0)
    assert.equal(sent(host).length, afterOff + 1)
  } finally { await host.cleanup() }
})

test('watch all rejects archives, subagents, delegated and unregistered sessions', async () => {
  const host = await hostScenario()
  try {
    await host.feed(update(1, '/watch all'))
    for (const [id, header] of [
      ['session-archived', {}], ['session-child', { origin: 'subagent' }],
      ['session-delegated', { delegationDepth: 1 }], ['session-orphan', {}],
    ]) {
      host.emit(id, 1, 'turn/start', { turn: 1 }, header)
      host.emit(id, 2, 'assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'not allowed' }] } }, header)
      host.emit(id, 3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, header)
    }
    // Allowed session provides a deterministic FIFO/persistence barrier.
    host.emit('session-web', 1, 'turn/start', { turn: 1 })
    await host.cursor('session-web', 1)
    assert.equal(host.calls.filter(call => call.method === 'createForumTopic').length, 1)
    assert.ok(sent(host).every(call => !call.body.text.includes('not allowed')))
  } finally { await host.cleanup() }
})

test('ordinary Web fork lineage is watched and accepts native queued prompt', async () => {
  const host = await hostScenario()
  try {
    await host.feed(update(1, '/watch all'))
    const header = { parentSession: 'session-web', isSeeded: true }
    host.emit('session-parented', 20, 'turn/start', { turn: 2 }, header)
    host.emit('session-parented', 21, 'assistant/message', { turn: 2, message: { content: [{ type: 'text', text: 'ordinary fork answer' }] } }, header)
    host.emit('session-parented', 22, 'turn/end', { turn: 2, reason: { kind: 'completed' } }, header)
    await host.cursor('session-parented', 22)
    assert.equal(host.calls.filter(call => call.method === 'createForumTopic').length, 1)
    assert.equal(sent(host).find(call => call.body.text.includes('ordinary fork answer')).body.message_thread_id, 7001)
    await host.feed(update(2, 'continue the fork', 7001))
    assert.deepEqual(host.prompts, [{ sessionId: 'session-parented', requestId: 'telegram:100:2', mode: 'queue', content: [{ type: 'text', text: 'continue the fork' }] }])
    assert.equal(host.creates.length, 0)
  } finally { await host.cleanup() }
})

test('forged model effort and permission callbacks never mutate the bound agent policy', async () => {
  const host = await hostScenario()
  try {
    await bindWeb(host)
    await host.feed(callback(2, 'm:deepseek-v4-pro'), callback(3, 'e:max'), callback(4, 'p:danger-full-access'))
    assert.deepEqual(host.mutations, [], 'legacy keyboards cannot change model/effort/permissions')
    assert.equal(host.prompts.length, 0)
    assert.equal(host.creates.length, 0)
  } finally { await host.cleanup() }
})

test('empty allowlist never admits text or creates a session', async () => {
  const host = await hostScenario([])
  try {
    await host.feed(update(1, 'create a session'), update(2, '/watch all'))
    host.emit('session-web', 1, 'turn/start', { turn: 1 })
    await host.feed(update(3, 'another denied prompt'))
    assert.equal(host.creates.length, 0)
    assert.equal(host.prompts.length, 0)
    assert.equal(host.calls.filter(call => call.method === 'createForumTopic').length, 0)
    assert.ok(sent(host).every(call => !call.body.text.includes(botFixture)))
  } finally { await host.cleanup() }
})
