import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import https from 'node:https'

/**
 * One fake DSH agent that settles a Telegram turn without model streaming.
 */
function makeAgent(id, cwd) {
  const events = new EventEmitter()
  return {
    session: { id, header: { cwd }, append() {} },
    ctx: { on: (...args) => events.on(...args) },
    status: 'idle',
    received: [],
    inbox: { clear() {} },
    cancel() {},
  }
}

/**
 * Build a fake Host context with the seams the Telegram bridge reads.
 */
function makeContext(agent) {
  const cleanups = []
  const logs = []
  const host = new EventEmitter()
  const workspace = { id: 'workspace-default', path: '/tmp/default-workspace', title: 'default-workspace', sessionIds: ['one'] }
  const services = {
    credentials: { resolve: async () => ({ value: 'TEST_TOKEN' }) },
    agents: { get: (id) => id === agent.session.id ? agent : undefined },
    sessionController: {
      create: async ({ workspaceId }) => {
        assert.equal(workspaceId, workspace.id)
        return { sessionId: agent.session.id }
      },
      resolveAgent: async () => ({ agent }),
      list: async (options) => { assert.deepEqual(options, {}); return { items: [{ sessionId: agent.session.id, blank: false, running: false }] } },
      prompt: async (request) => {
        assert.equal(request.mode, 'queue')
        agent.received.push(request)
        return { accepted: true }
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
    llm: {
      listModels: async () => [],
      resolveModel: async () => ({ context: { contextWindow: 1_000_000 } }),
    },
  }
  return {
    ctx: {
      logger: { info(message) { logs.push(`I ${message}`) }, warn(message) { logs.push(`W ${message}`) } },
      get: (name) => services[name],
      sessionController: services.sessionController,
      workspaceRegistry: services.workspaceRegistry,
      on(name, listener) { host.on(name, listener); return () => host.off(name, listener) },
      effect(fn) {
        cleanups.push(fn())
      },
    },
    logs,
    cleanup: () => {
      for (const fn of cleanups) fn?.()
    },
    services,
  }
}

test('All message creates one topic, then the same topic continues', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-telegram-test-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const agent = makeAgent('session-one', '/tmp/default-workspace')
  const { ctx, cleanup, logs } = makeContext(agent)
  const calls = []
  let getUpdatesCalls = 0
  let updateConsumed = false
  const originalRequest = https.request
  https.request = (options, callback) => {
    const method = String(options.path).split('/').pop()
    const request = new EventEmitter()
    const response = new EventEmitter()
    response.setEncoding = () => {}
    response.statusCode = 200
    let body = ''
    request.end = (value = '') => {
      body = value
      let result = {}
      let error
      if (method === 'getMe') result = { id: 1, username: 'testbot' }
      else if (method === 'createForumTopic') {
        calls.push({ method, body: JSON.parse(body) })
        result = { message_thread_id: 7001 }
      } else if (method === 'sendMessage' || method === 'editMessageText') {
        calls.push({ method, body: JSON.parse(body) })
        result = { message_id: calls.length }
      } else if (method === 'getUpdates') {
        getUpdatesCalls += 1
        if (!updateConsumed) {
          updateConsumed = true
          result = [{
              update_id: 1,
              message: {
                message_id: 1,
                date: 1,
                chat: { id: 100, type: 'private' },
                from: { id: 42 },
                message_thread_id: 1,
                text: 'hello from All',
              },
            }]
        } else if (getUpdatesCalls === 2) {
          result = [{ update_id: 2, message: {
            message_id: 2, date: 1, chat: { id: 100, type: 'private' }, from: { id: 42 },
            message_thread_id: 7001, text: 'continue in topic',
          } }]
        } else {
          return // Keep the last long poll pending until cleanup aborts it.
        }
      } else {
        result = true
      }
      // Deliver only after https.request has invoked its response callback.
      setImmediate(() => {
        response.emit('data', JSON.stringify(error ?? { ok: true, result }))
        response.emit('end')
        request.emit('close')
      })
    }
    request.destroy = () => {}
    request.on = (name, fn) => EventEmitter.prototype.on.call(request, name, fn)
    process.nextTick(() => callback(response))
    return request
  }
  try {
    const { apply } = await import(`../index.js?scenario=${encodeURIComponent(home)}`)
    apply(ctx, {
      enabled: true,
      tokenRef: 'TEST_TOKEN',
      allowedUsers: ['42'],
      allowedChats: ['100'],
      cwd: '/tmp/default-workspace',
      language: 'en',
      showThinking: false,
    })
    const deadline = Date.now() + 2000
    while (getUpdatesCalls < 3) {
      assert.ok(Date.now() < deadline, 'updates must settle')
      await new Promise(setImmediate)
    }
    const topicCalls = calls.filter((entry) => entry.method === 'createForumTopic')
    assert.equal(topicCalls.length, 1, 'All message must create exactly one topic')
    assert.equal(topicCalls[0].body.name, 'New session')
    assert.equal(agent.received.length, 2, 'initial and continuation prompts reach the same session')
    assert.equal(agent.received[0].content[0].text, 'hello from All')
    assert.equal(agent.received[1].content[0].text, 'continue in topic')
    assert.deepEqual(agent.received.map(request => request.requestId), ['telegram:100:1', 'telegram:100:2'])
    assert.ok(agent.received.every(request => request.sessionId === agent.session.id))
  } finally {
    cleanup()
    https.request = originalRequest
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 10 })
  }
})
