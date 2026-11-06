import assert from 'node:assert/strict'
import test from 'node:test'
import { admitPrompt, assertOrdinarySession, createUpdateAdmission, createWorkspaceSession, resolveSessionAgent, stopSession } from './session-api.js'

function host() {
  const rows = [{ sessionId: 'session-demo', running: true, blank: false, cwd: '/synthetic' }]
  const workspace = { id: 'workspace-demo', path: '/synthetic', sessionIds: ['session-demo'] }
  const calls = []
  const agent = { inbox: { clear: () => calls.push(['clear']) }, cancel: (...args) => calls.push(['cancel', ...args]) }
  const services = {
    sessionController: {
      list: async () => ({ items: rows }),
      create: async (request) => { calls.push(['create', request]); return { sessionId: 'session-created' } },
      resolveAgent: async (id) => { calls.push(['resolve', id]); return { agent } },
      prompt: async (request) => { calls.push(['prompt', request]); return { accepted: true } },
    },
    agents: { get: (id) => id === 'session-demo' ? agent : undefined },
    workspaceRegistry: { list: () => [workspace], archivedSessionIds: [] },
  }
  return { ctx: { get: (name) => services[name] }, calls, services, rows }
}

test('create uses registered workspace and returned identity without raw fallback', async () => {
  const { ctx, calls } = host()
  assert.equal(await createWorkspaceSession(ctx, '/synthetic', undefined), 'session-created')
  assert.equal(calls[0][0], 'create')
  assert.equal(calls[0][1].workspaceId, 'workspace-demo')
  assert.match(calls[0][1].sessionId, /^session-[0-9a-f-]{36}$/)
  assert.equal(calls[0][1].agentPreset, undefined)
  await assert.rejects(createWorkspaceSession(ctx, '/unregistered'), /existing DSH workspace/)
})

test('cold resolve never overwrites model or permissions and fails closed', async () => {
  const { ctx, calls, services } = host()
  assert.ok(await resolveSessionAgent(ctx, 'session-demo'))
  assert.deepEqual(calls, [['resolve', 'session-demo']])
  services.sessionController.resolveAgent = async () => ({ error: { code: 'session/writer-held' } })
  await assert.rejects(resolveSessionAgent(ctx, 'session-demo'), /writer-held/)
  assert.equal(calls.some(([kind]) => kind === 'create'), false)
})

test('archived aliases and child sessions never admit prompts', async () => {
  const { ctx, services, rows } = host()
  services.workspaceRegistry.archivedSessionIds = ['demo']
  await assert.rejects(assertOrdinarySession(ctx, 'session-demo'), /Archived/)
  services.workspaceRegistry.archivedSessionIds = []
  rows[0].origin = 'subagent'
  await assert.rejects(assertOrdinarySession(ctx, 'session-demo'), /ordinary root/)
  delete rows[0].origin
  rows[0].parentSessionId = 'parent'
  assert.equal((await assertOrdinarySession(ctx, 'session-demo')).row.sessionId, 'session-demo', 'ordinary fork ancestry is not child-agent ownership')
})

test('busy session prompt goes through queue with stable Telegram identity', async () => {
  const { ctx, calls } = host()
  const input = { sessionId: 'session-demo', chatId: 123, messageId: 45, text: 'continue' }
  await admitPrompt(ctx, input, new AbortController().signal)
  const request = calls.find(([kind]) => kind === 'prompt')[1]
  assert.deepEqual(request, { sessionId: 'session-demo', requestId: 'telegram:123:45', mode: 'queue', content: [{ type: 'text', text: 'continue' }] })
  await assert.rejects(admitPrompt(ctx, { ...input, messageId: undefined }), /identity/)
})

test('live registry ownership excludes old child headers without origin', async () => {
  const { ctx, services, rows } = host()
  const parent = { id: 'parent' }, child = { id: 'session-demo' }
  rows[0].parentSessionId = 'parent'
  services.agents = { get: id => ({ parent, 'session-demo': child })[id], isOwnedBy: (id, owner) => id === child.id && owner === parent }
  await assert.rejects(assertOrdinarySession(ctx, 'session-demo'), /ordinary root/)
})

test('files use Agent-scoped upload receipts and images native encoded parts', async () => {
  const { ctx, services, calls } = host()
  services.fileUploads = { upload: async (agent, request, signal) => {
    assert.ok(agent)
    assert.deepEqual(request, { data: 'ZmlsZQ==', name: 'example.txt' })
    assert.ok(signal instanceof AbortSignal)
    return { receiptId: 'synthetic-receipt' }
  } }
  const image = { type: 'image', data: 'aW1hZ2U=', mediaType: 'image/png', name: 'example.png' }
  await admitPrompt(ctx, { sessionId: 'session-demo', chatId: 123, messageId: 46, text: 'read', attachments: [
    { type: 'telegram-file', data: 'ZmlsZQ==', name: 'example.txt' }, image,
  ] }, new AbortController().signal)
  assert.deepEqual(calls.find(([kind]) => kind === 'prompt')[1].content, [
    { type: 'text', text: 'read' }, { type: 'file', receiptId: 'synthetic-receipt' }, image,
  ])
})

test('stop clears inbox by default and does not claim to kill jobs', () => {
  const { ctx, calls } = host()
  assert.equal(stopSession(ctx, 'session-demo'), true)
  assert.deepEqual(calls, [['clear'], ['cancel', { kind: 'user' }]])
})

test('admission serializes concurrent duplicate update before effects', async () => {
  const state = {}
  let writes = 0
  const seen = []
  const admission = createUpdateAdmission({ state: () => state, persist: async () => { writes++ }, handle: async (update) => seen.push(update.update_id) })
  await Promise.all([admission.accept({ update_id: 10 }), admission.accept({ update_id: 10 }), admission.accept({ update_id: 11 })])
  assert.deepEqual(seen, [10, 11])
  assert.equal(state.updateOffset, 12)
  assert.equal(writes, 4)
})

test('failed persistence prevents effect; restart does not repeat unknown operation', async () => {
  const state = {}
  let effects = 0
  let uncertain = 0
  const failed = createUpdateAdmission({ state: () => state, persist: async () => { throw new Error('disk full') }, handle: async () => effects++ })
  await assert.rejects(failed.accept({ update_id: 1 }), /disk full/)
  assert.equal(effects, 0)
  const restart = createUpdateAdmission({ state: () => state, persist: async () => {}, handle: async () => effects++, uncertain: async () => uncertain++ })
  await restart.accept({ update_id: 1 })
  assert.equal(effects, 0)
  assert.equal(uncertain, 1)
})

test('a crash after uncertain admission is not replayed on restart', async () => {
  const state = {}
  let effects = 0
  const first = createUpdateAdmission({ state: () => state, persist: async () => {}, handle: async () => { effects++; throw new Error('unknown outcome') } })
  await assert.rejects(first.accept({ update_id: 7 }), /unknown/)
  const restart = createUpdateAdmission({ state: () => state, persist: async () => {}, handle: async () => effects++ })
  await restart.accept({ update_id: 7 })
  assert.equal(effects, 1)
  assert.equal(state.updateLedger['7'], 'uncertain')
  assert.equal(state.updateOffset, 8)
})
