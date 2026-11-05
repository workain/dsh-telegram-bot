/** Fail closed on damaged runtime state; never silently repair identity links. */
export function validatePluginState(value) {
  const record = object => object !== null && typeof object === 'object' && !Array.isArray(object)
  const integer = number => Number.isSafeInteger(number)
  const check = condition => { if (!condition) throw new Error('Invalid Telegram runtime state; restore a verified snapshot') }
  check(record(value) && [2, 3].includes(value.version) && record(value.sessions) && record(value.threads))
  for (const [id, binding] of Object.entries(value.sessions)) {
    check(record(binding) && binding.sessionId === id && integer(binding.chatId) && integer(binding.threadId) && binding.threadId > 1)
    check(value.threads[`${binding.chatId}:${binding.threadId}`] === id)
  }
  for (const [key, id] of Object.entries(value.threads)) {
    const binding = value.sessions[id]
    check(typeof id === 'string' && binding && key === `${binding.chatId}:${binding.threadId}`)
  }
  const owner = value.subscription
  if (owner !== undefined) {
    check(record(owner))
    if (owner.userId !== undefined) check(integer(owner.userId) && owner.userId > 0)
    if (owner.chatId !== undefined) check(integer(owner.chatId) && owner.chatId > 0)
    if (owner.paused !== undefined) check(typeof owner.paused === 'boolean')
    if (owner.generation !== undefined) check(integer(owner.generation) && owner.generation >= 0)
    if (owner.workspaceIds !== undefined) check(Array.isArray(owner.workspaceIds) && owner.workspaceIds.every(id => typeof id === 'string'))
  }
  if (value.updateOffset !== undefined) check(integer(value.updateOffset) && value.updateOffset >= 0)
  if (value.updateLedger !== undefined) {
    check(record(value.updateLedger))
    for (const [key, status] of Object.entries(value.updateLedger)) check(/^\d+$/.test(key) && ['pending', 'done', 'uncertain'].includes(status))
  }
  if (value.topicAttempts !== undefined) {
    check(record(value.topicAttempts))
    check(Object.values(value.topicAttempts).every(status => status === 'pending'))
  }
  const watch = value.watch
  if (watch === undefined) return
  check(record(watch))
  if (watch.bindings !== undefined) {
    check(record(watch.bindings))
    for (const [key, binding] of Object.entries(watch.bindings)) {
      check(record(binding))
      const canonical = value.sessions[binding.sessionId]
      check(canonical && key === JSON.stringify([binding.chatId, binding.sessionId])
        && binding.chatId === canonical.chatId && binding.threadId === canonical.threadId)
    }
  }
  if (watch.bindingErrors !== undefined) check(record(watch.bindingErrors))
  if (watch.sessions !== undefined) {
    check(record(watch.sessions))
    for (const session of Object.values(watch.sessions)) {
      check(record(session) && integer(session.cursor) && session.cursor >= -1
        && Array.isArray(session.handled) && session.handled.every(seq => integer(seq) && seq >= 0)
        && record(session.turns))
      if (session.generation !== undefined) check(integer(session.generation) && session.generation >= 0)
      for (const draft of Object.values(session.turns)) {
        check(record(draft) && typeof draft.text === 'string')
        if (draft.progress !== undefined) check(record(draft.progress) && integer(draft.progress.count)
          && draft.progress.count >= 0 && draft.progress.count <= 10
          && (draft.progress.last === null || typeof draft.progress.last === 'string'))
      }
    }
  }
}
