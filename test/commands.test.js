import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'

function makeAgent(id, cwd, idleMs) {
  const events = new EventEmitter()
  const operations = [], pending = []
  return {
    session: { id, header: { cwd }, append() {} },
    ctx: { on: (...args) => events.on(...args) },
    events,
    status: 'idle',
    received: [],
    cancellations: [],
    operations,
    inbox: { pending, clear() { operations.push('clear'); pending.splice(0) } },
    cancel(reason) { operations.push('cancel'); this.cancellations.push(reason) },
  }
}

function makeContext(agent) {
  const logs = []
  const cleanups = []
  const uploads = []
  const fileUploads = {
    async upload(receiver, request, signal) {
      assert.equal(receiver, agent, 'receipt is scoped to the exact receiving agent')
      assert.ok(signal instanceof AbortSignal)
      assert.equal(signal.aborted, false)
      assert.deepEqual(request, { data: Buffer.from('file-data').toString('base64'), name: 'test.txt' })
      uploads.push({ receiver, request })
      return { receiptId: 'receipt-test-file' }
    },
  }
  const host = new EventEmitter()
  const workspace = { id: 'workspace-default', path: '/tmp/default-workspace', title: 'default-workspace', sessionIds: ['one'] }
  const rows = [{ sessionId: agent.session.id, blank: false, running: false }]
  const services = {
    credentials: { resolve: async () => ({ value: 'TEST_TOKEN' }) },
    agents: { get: (id) => id === agent.session.id ? agent : undefined },
    sessionController: {
      create: async (options) => {
        assert.equal(options.workspaceId, workspace.id)
        return { sessionId: agent.session.id }
      },
      resolveAgent: async () => ({ agent }),
      list: async (options) => { assert.deepEqual(options, {}); return { items: rows } },
      prompt: async (request) => {
        assert.equal(request.mode, 'queue')
        agent.received.push(request)
        agent.inbox.pending.push(request)
        return { accepted: true }
      },
      fork: async () => {
        rows.push({ sessionId: 'session-fork', blank: false, running: false })
        workspace.sessionIds.push('fork')
        return { sessionId: 'session-fork' }
      },
    },
    sessionQuery: {
      listSessions: async () => [],
      readTitleSnapshot: async () => ({ title: { title: 'Generated title' } }),
      readSurface: async () => ({ events: [] }),
      readSession: async () => ({ events: [] }),
    },
    workspaceRegistry: {
      list: () => [workspace],
      archivedSessionIds: [],
      get: () => undefined,
      create: async () => ({ id: 'workspace-default' }),
    },
    fileUploads,
    llm: { listModels: async () => [], resolveModel: async () => ({ context: { contextWindow: 1_000_000 } }) },
  }
  return {
    ctx: {
      logger: { info(message) { logs.push(`I ${message}`) }, warn(message) { logs.push(`W ${message}`) } },
      get: (name) => services[name],
      sessionController: services.sessionController,
      workspaceRegistry: services.workspaceRegistry,
      on(name, listener) { host.on(name, listener); return () => host.off(name, listener) },
      effect(fn) { cleanups.push(fn()) },
    },
    logs,
    host,
    uploads,
    cleanup: () => { for (const fn of cleanups) fn?.() },
  }
}

function makeTelegram(updates) {
  const calls = []
  let messageId = 0
  let topicId = 7000
  let updateIndex = 0
  let drained = false
  const fake = (options, callback) => {
    const method = String(options.path).split('/').pop()
    const request = new EventEmitter()
    const response = new EventEmitter()
    response.setEncoding = () => {}
    response.statusCode = 200
    request.destroy = () => {}
    request.on = (name, fn) => EventEmitter.prototype.on.call(request, name, fn)
    process.nextTick(() => callback(response))

    const deliver = (payload) => {
      setImmediate(() => {
        response.emit('data', payload)
        response.emit('end')
        request.emit('close')
      })
    }

    let body = ''
    request.end = (value = '') => {
      body = value
      if (String(options.path).includes('/file/')) {
        setImmediate(() => {
          response.emit('data', Buffer.from('file-data'))
          response.emit('end')
          request.emit('close')
        })
        return
      }
      if (method === 'getMe') {
        deliver(JSON.stringify({ ok: true, result: { id: 1, username: 'testbot' } }))
        return
      }
      if (method === 'getFile') {
        calls.push({ method, body: body.length > 0 ? JSON.parse(body) : undefined })
        deliver(JSON.stringify({ ok: true, result: { file_path: 'files/test.txt', file_size: 9 } }))
        return
      }
      if (method === 'getUpdates') {
        const update = updates[updateIndex]
        if (update === undefined) {
          drained = true
          return
        }
        updateIndex += 1
        deliver(JSON.stringify({ ok: true, result: [update] }))
        return
      }
      let result = true
      if (method === 'createForumTopic') {
        topicId += 1
        result = { message_thread_id: topicId }
      } else if (method === 'editForumTopic') {
        calls.push({ method, body: JSON.parse(body) })
        result = true
      } else if (method === 'sendMessage' || method === 'editMessageText') {
        messageId += 1
        result = { message_id: messageId }
      }
      calls.push({ method, body: body.length > 0 ? JSON.parse(body) : undefined })
      deliver(JSON.stringify({ ok: true, result }))
    }
    return request
  }
  return { fake, calls, get drained() { return drained } }
}

async function until(predicate, detail = 'expected event') {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${detail}`)
    await new Promise(setImmediate)
  }
}

async function runScenario(updates, idleMs = 20, waitMs = 400, afterReady) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-telegram-command-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const agent = makeAgent('session-one', '/tmp/default-workspace', idleMs)
  const context = makeContext(agent)
  const telegram = makeTelegram(updates)
  const originalRequest = https.request
  https.request = telegram.fake
  try {
    const { apply } = await import(`../index.js?scenario=${encodeURIComponent(home)}`)
    apply(context.ctx, {
      enabled: true,
      tokenRef: 'TEST_TOKEN',
      allowedUsers: ['42'],
      allowedChats: ['100'],
      cwd: '/tmp/default-workspace',
      language: 'en',
      showThinking: false,
    })
    await until(() => telegram.drained, 'updates processed')
    if (afterReady !== undefined) await afterReady({ agent, host: context.host, calls: telegram.calls })
    return { calls: telegram.calls, agent, uploads: context.uploads, logs: context.logs, cleanup: async () => {
      context.cleanup()
      await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
    } }
  } catch (error) {
    context.cleanup()
    throw error
  } finally {
    https.request = originalRequest
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
}

const all = (text) => ({
  update_id: 1,
  message: { message_id: 1, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, message_thread_id: 1, text },
})
const topic = (threadId, text, delay = 100) => ({
  delay,
  update_id: 2,
  message: { message_id: 2, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 }, message_thread_id: threadId, text },
})
const topicFile = (threadId, delay = 100) => ({
  delay,
  update_id: 2,
  message: {
    message_id: 2,
    date: 1,
    chat: { id: 100, type: 'private' },
    from: { id: 42 },
    message_thread_id: threadId,
    caption: 'read this file',
    document: { file_id: 'f1', file_name: 'test.txt', mime_type: 'text/plain', file_size: 9 },
  },
})

test('/restart in All never creates a session topic', async () => {
  const result = await runScenario([all('/restart@boobawnebot')], 20, 500)
  try {
    const topics = result.calls.filter((call) => call.method === 'createForumTopic')
    assert.equal(topics.length, 0)
  } finally {
    await result.cleanup()
  }
})

test('fork creates one new topic with the requested name', async () => {
  const result = await runScenario([all('hello'), topic(7001, '/fork branch', 400)], 20, 900)
  try {
    const topics = result.calls.filter((call) => call.method === 'createForumTopic')
    assert.equal(topics.length, 2, 'initial topic plus fork topic')
    assert.equal(topics[1].body.name, 'branch')
    assert.equal(result.logs.filter((line) => line.startsWith('W ') && !line.includes('getUpdates failed')).length, 0, result.logs.join('\n'))
  } finally {
    await result.cleanup()
  }
})

test('a provider title event renames the existing topic', async () => {
  const result = await runScenario([all('hello')], 20, 350, async ({ agent, host, calls }) => {
    host.emit('session/event', agent.session, {
      seq: 1, type: 'session/title',
      data: { title: 'Provider title' },
    })
    await until(() => calls.some((call) => call.method === 'editForumTopic' && call.body.name === 'Provider title'), 'provider title rename')
  })
  try {
    const edits = result.calls.filter((call) => call.method === 'editForumTopic')
    assert.equal(edits.length > 0, true)
    assert.equal(edits.at(-1).body.name, 'Provider title')
  } finally {
    await result.cleanup()
  }
})

test('stop clears an idle parked inbox once without discarding later submissions', async () => {
  const later = topic(7001, 'submitted after stop', 0)
  later.update_id = 3
  later.message.message_id = 3
  const result = await runScenario([
    all('slow task'),
    topic(7001, '/stop', 120),
    topic(7001, '/stop', 160),
    later,
  ], 1000, 500)
  try {
    assert.equal(result.logs.some((line) => line.includes('warn is not defined')), false)
    const stopped = result.calls.filter((call) =>
      call.method === 'sendMessage' && typeof call.body?.text === 'string' && call.body.text.includes('Stop requested') && call.body.text.includes('pending session input discarded'),
    )
    assert.equal(stopped.length, 1)
    assert.deepEqual(result.agent.operations, ['clear', 'cancel'], 'idle Inbox.clear precedes cancellation, which alone is a no-op while idle')
    assert.deepEqual(result.agent.cancellations, [{ kind: 'user' }])
    assert.equal(result.agent.received.length, 2, 'both earlier and later submissions were admitted')
    assert.deepEqual(result.agent.inbox.pending.map(request => request.requestId), ['telegram:100:3'], 'clear discards only input parked before stop')
  } finally {
    await result.cleanup()
  }
})

test('a Telegram photo uses native image bytes rather than an attachment reference', async () => {
  const photo = topicFile(1, 0)
  delete photo.message.document
  photo.message.photo = [{ file_id: 'photo-small', width: 10, height: 10 }, { file_id: 'photo-large', width: 100, height: 100 }]
  photo.message.caption = 'inspect this photo'
  const result = await runScenario([photo])
  try {
    assert.equal(result.agent.received.length, 1)
    assert.deepEqual(result.agent.received[0].content, [
      { type: 'text', text: 'inspect this photo' },
      { type: 'image', data: Buffer.from('file-data').toString('base64'), mediaType: 'image/jpeg', name: 'telegram-photo-2.jpg' },
    ])
    assert.equal(result.uploads.length, 0, 'images do not use document upload receipts')
    assert.deepEqual(result.calls.find(call => call.method === 'getFile').body, { file_id: 'photo-large' })
  } finally { await result.cleanup() }
})

test('a document in All reaches the agent as a file attachment', async () => {
  const result = await runScenario([topicFile(1, 0)], 20, 500)
  try {
    assert.equal(result.calls.filter((call) => call.method === 'createForumTopic').length, 1)
    assert.equal(result.agent.received.length, 1)
    const content = result.agent.received[0].content
    assert.deepEqual(content, [{ type: 'text', text: 'read this file' }, { type: 'file', receiptId: 'receipt-test-file' }])
    assert.equal(result.uploads.length, 1)
    assert.equal(result.uploads[0].receiver, result.agent)
    assert.equal(result.uploads[0].request.name, 'test.txt')
  } finally {
    await result.cleanup()
  }
})
