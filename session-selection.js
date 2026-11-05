/**
 * Pure catalog selection for bulk topic attachment, never Session activation.
 * Returned entries are the original row objects, not copied/forked sessions.
 *
 * Membership and archive identities normalize the native `session-` prefix.
 * Ordinary user forks remain eligible: parentSessionId is ancestry, not proof
 * of subagent ownership. The Host must still apply its live ownership fence
 * before attaching a selected row.
 *
 * Hour/day use an inclusive lower bound and include running sessions regardless
 * of timestamp. Finite future timestamps are accepted: clock skew must not hide
 * a recently active session. Missing/non-finite timestamps only qualify when
 * running. Unknown ranges or unknown requested workspaces fail closed.
 */
const canonicalId = id => typeof id === 'string' ? id.replace(/^session-/, '') : ''
const compareId = (left, right) => left < right ? -1 : left > right ? 1 : 0
const timestamp = row => Number.isFinite(row.updatedAt) ? row.updatedAt : -Infinity
const windows = { hour: 60 * 60 * 1000, day: 24 * 60 * 60 * 1000 }

export function selectSessions({ rows, workspaces, archivedSessionIds = [], workspaceId, range, now } = {}) {
  if (!['running', 'hour', 'day', 'all'].includes(range)) return []
  if ((range === 'hour' || range === 'day') && !Number.isFinite(now)) return []
  if (!Array.isArray(rows) || !Array.isArray(workspaces)) return []
  const selectedWorkspaces = workspaceId === undefined
    ? workspaces
    : workspaces.filter(workspace => workspace?.id === workspaceId)
  if (selectedWorkspaces.length === 0) return []
  const members = new Set(selectedWorkspaces.flatMap(workspace =>
    Array.isArray(workspace?.sessionIds) ? workspace.sessionIds.map(canonicalId).filter(Boolean) : []))
  const archives = new Set(Array.isArray(archivedSessionIds)
    ? archivedSessionIds.map(canonicalId).filter(Boolean) : [])
  const boundary = now - windows[range]
  const eligible = rows.filter(row => {
    if (!row || typeof row !== 'object') return false
    const id = canonicalId(row.sessionId)
    if (!id || !members.has(id) || archives.has(id) || row.blank !== false
      || row.origin === 'subagent' || row.formatStatus === 'migration-required') return false
    if (range === 'all' || row.running === true) return true
    return range !== 'running' && Number.isFinite(row.updatedAt) && row.updatedAt >= boundary
  })
  eligible.sort((left, right) => {
    const running = Number(right.running === true) - Number(left.running === true)
    if (running) return running
    const leftTime = timestamp(left), rightTime = timestamp(right)
    if (leftTime !== rightTime) return leftTime > rightTime ? -1 : 1
    return compareId(canonicalId(left.sessionId), canonicalId(right.sessionId))
      || compareId(left.sessionId, right.sessionId)
  })
  const seen = new Set()
  return eligible.filter(row => {
    const id = canonicalId(row.sessionId)
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
