import { randomUUID } from 'node:crypto'

/** DSH 0.2 Host admission. No raw-agent fallback or implicit policy changes. */
export function canonicalSessionId(id) {
  return String(id).replace(/^session-/, '')
}

export async function sessionRows(ctx, signal) {
  const controller = ctx.get('sessionController')
  if (!controller?.list) throw new Error('DSH sessionController.list is required')
  const value = await controller.list({}, signal)
  return Array.isArray(value) ? value : value.items ?? []
}

/** Mirror the installed controller's live ownership fence without activating it. */
export function hasLiveSubagentOwner(ctx, sessionId, header) {
  if (header?.origin === 'subagent') return true
  const parentId = header?.parentSession ?? header?.parentSessionId
  if (!parentId) return false
  const agents = ctx.get?.('agents') ?? ctx.agents
  const agent = agents?.get(sessionId)
  const parent = agents?.get(parentId)
  if (!agent || !parent) return false // ordinary cold forks remain eligible
  return typeof agents.isOwnedBy !== 'function' || agents.isOwnedBy(agent.id ?? sessionId, parent)
}

export async function assertOrdinarySession(ctx, sessionId, signal) {
  const id = canonicalSessionId(sessionId)
  const registry = ctx.get('workspaceRegistry')
  const archived = new Set([...(registry?.archivedSessionIds ?? [])].map(canonicalSessionId))
  if (archived.has(id)) throw new Error('Archived session: restore it in DSH first')
  const row = (await sessionRows(ctx, signal)).find((entry) => canonicalSessionId(entry.sessionId) === id)
  // parentSessionId is ordinary fork lineage, not subagent ownership.
  if (!row || hasLiveSubagentOwner(ctx, row.sessionId, row) || row.formatStatus === 'migration-required') {
    throw new Error('An available ordinary root session is required')
  }
  const workspace = registry?.list().find((entry) => entry.sessionIds?.some((value) => canonicalSessionId(value) === id))
  if (!workspace) throw new Error('Session must belong to a registered workspace')
  return { row, workspace }
}

export async function createWorkspaceSession(ctx, cwd, agentPreset, signal) {
  const workspace = ctx.get('workspaceRegistry')?.list().find((entry) => entry.path === cwd)
  if (!workspace) throw new Error('Choose an existing DSH workspace with /sessions')
  if (signal?.aborted) throw new Error('Request cancelled')
  const controller = ctx.get('sessionController')
  if (!controller?.create) throw new Error('DSH sessionController.create is required')
  const result = await controller.create({ sessionId: `session-${randomUUID()}`, workspaceId: workspace.id, ...(agentPreset ? { agentPreset } : {}) })
  if (typeof result?.sessionId !== 'string') throw new Error('DSH returned no session identity')
  return result.sessionId
}

export async function resolveSessionAgent(ctx, sessionId, signal) {
  await assertOrdinarySession(ctx, sessionId, signal)
  const controller = ctx.get('sessionController')
  if (!controller?.resolveAgent) throw new Error('DSH sessionController.resolveAgent is required')
  const result = await controller.resolveAgent(sessionId)
  if (!result?.agent) throw new Error(result?.error?.message ?? result?.error?.code ?? 'Cannot resume session')
  return result.agent
}

/** Deterministic identity lets DSH deduplicate a sequential transport retry. */
export function promptRequestId(chatId, messageId) {
  if (!Number.isSafeInteger(chatId) || !Number.isSafeInteger(messageId)) throw new Error('Telegram message identity required')
  return `telegram:${chatId}:${messageId}`
}

export async function admitPrompt(ctx, { sessionId, chatId, messageId, text, attachments = [] }, signal) {
  await assertOrdinarySession(ctx, sessionId, signal)
  if (signal?.aborted) throw new Error('Request cancelled')
  const parts = []
  for (const attachment of attachments) {
    if (attachment.type === 'telegram-file') {
      const uploads = ctx.get('fileUploads')
      if (!uploads?.upload) throw new Error('DSH file upload service is required')
      const agent = await resolveSessionAgent(ctx, sessionId, signal)
      const receipt = await uploads.upload(agent, { data: attachment.data, name: attachment.name }, signal)
      parts.push({ type: 'file', receiptId: receipt.receiptId })
    } else if (attachment.type === 'image' && typeof attachment.data === 'string' && typeof attachment.mediaType === 'string') {
      parts.push(attachment)
    } else throw new Error('Unsupported Telegram attachment')
  }
  return ctx.get('sessionController').prompt({
    sessionId,
    requestId: promptRequestId(chatId, messageId),
    mode: 'queue',
    content: [...(text.trim() ? [{ type: 'text', text }] : []), ...parts],
  }, signal)
}

/** Stop only this agent and its pending inbox, not background jobs or children. */
export function stopSession(ctx, sessionId) {
  const agent = ctx.get('agents')?.get(sessionId)
  if (!agent) return false
  // cancel() alone is a no-op while idle; clear durable parked input as well.
  agent.inbox.clear()
  agent.cancel({ kind: 'user' })
  return true
}

/** Claim BEFORE side effects: unknown/crashed operations are never auto-replayed. */
export function createUpdateAdmission({ state, persist, handle, uncertain }) {
  let tail = Promise.resolve()
  async function process(update, signal) {
    if (!Number.isSafeInteger(update.update_id)) return
    const document = state()
    document.updateLedger ??= {}
    const key = String(update.update_id)
    const previous = document.updateLedger[key]
    if (previous) {
      if (previous === 'pending') {
        document.updateLedger[key] = 'uncertain'
        document.updateOffset = Math.max(document.updateOffset ?? 0, update.update_id + 1)
        await persist()
        await uncertain?.(update, signal)
      }
      return
    }
    if (update.update_id < (document.updateOffset ?? 0)) return
    document.updateLedger[key] = 'pending'
    await persist()
    // A failure leaves a durable pending marker. It is not safe to repeat create.
    await handle(update, signal)
    document.updateLedger[key] = 'done'
    document.updateOffset = Math.max(document.updateOffset ?? 0, update.update_id + 1)
    const keys = Object.keys(document.updateLedger).sort((a, b) => Number(b) - Number(a))
    for (const old of keys.slice(256)) delete document.updateLedger[old]
    await persist()
  }
  return {
    accept(update, signal) {
      const result = tail.then(() => process(update, signal))
      tail = result.catch(() => {})
      return result
    },
    idle: () => tail,
  }
}
