import test from 'node:test'
import assert from 'node:assert/strict'
import { selectSessions } from './session-selection.js'

const now = 1_800_000_000_000
const hour = 60 * 60 * 1000
const day = 24 * hour
const row = (id, fields = {}) => ({ sessionId: id, running: false, blank: false, updatedAt: now, ...fields })
function select(rows, options = {}) {
  return selectSessions({ rows, workspaces: [{ id: 'project-a', sessionIds: rows.map(item => item?.sessionId) }],
    archivedSessionIds: [], range: 'running', now, ...options })
}
const ids = rows => rows.map(item => item.sessionId)

test('running means genuinely running, not merely live or recently updated', () => {
  const active = row('active', { running: true, updatedAt: 0 })
  assert.deepEqual(select([row('recent'), active, row('truthy', { running: 'true' }), row('live', { agentAvailable: true })]), [active])
})

test('all is an individual picker range with normal eligibility filters, not a time window', () => {
  const rows = [row('old-idle', { updatedAt: 0 }), row('no-time', { updatedAt: undefined }),
    row('active', { running: true, updatedAt: 1 }), row('blank', { blank: true }), row('child', { origin: 'subagent' })]
  assert.deepEqual(ids(select(rows, { range: 'all', now: undefined })), ['active', 'old-idle', 'no-time'])
})

test('hour includes inclusive boundary, recent and running; excludes older idle', () => {
  const rows = [row('outside', { updatedAt: now - hour - 1 }), row('boundary', { updatedAt: now - hour }),
    row('recent', { updatedAt: now - 1 }), row('running-old', { running: true, updatedAt: 0 })]
  assert.deepEqual(ids(select(rows, { range: 'hour' })), ['running-old', 'recent', 'boundary'])
})

test('day is exactly twenty-four hours with an inclusive lower bound', () => {
  const rows = [row('older', { updatedAt: now - day - 1 }), row('boundary', { updatedAt: now - day }),
    row('today', { updatedAt: now - hour - 1 }), row('running-ancient', { running: true, updatedAt: 0 })]
  assert.deepEqual(ids(select(rows, { range: 'day' })), ['running-ancient', 'today', 'boundary'])
})

test('finite future timestamps remain eligible for clock skew, non-finite timestamps do not', () => {
  const rows = [row('future', { updatedAt: now + hour }), row('infinite', { updatedAt: Infinity }),
    row('not-number', { updatedAt: NaN }), row('string-time', { updatedAt: String(now) }),
    row('running-no-time', { running: true, updatedAt: undefined })]
  assert.deepEqual(ids(select(rows, { range: 'hour' })), ['running-no-time', 'future'])
})

test('blank, archived, migrating and subagent rows are excluded even when running', () => {
  const rows = [row('ordinary', { running: true }), row('blank', { running: true, blank: true }),
    row('unknown-blank', { running: true, blank: undefined }), row('archived', { running: true }),
    row('child', { running: true, origin: 'subagent' }), row('migration', { running: true, formatStatus: 'migration-required' })]
  assert.deepEqual(ids(select(rows, { archivedSessionIds: ['session-archived'] })), ['ordinary'])
})

test('ordinary fork ancestry does not exclude an original DSH session', () => {
  const fork = row('session-fork', { running: true, parentSessionId: 'session-parent', isSeeded: true })
  assert.deepEqual(select([fork]), [fork])
  assert.equal(select([fork])[0], fork, 'returns original row identity; does not fork or clone')
})

test('registered workspace membership is authoritative, cwd cannot grant membership', () => {
  const rows = [row('member', { running: true }), row('orphan', { running: true, cwd: '/same-project' })]
  const workspaces = [{ id: 'project-a', path: '/same-project', sessionIds: ['session-member'] }]
  assert.deepEqual(ids(select(rows, { workspaces })), ['member'])
})

test('workspace selection restricts scope and unknown requested workspace fails closed', () => {
  const rows = [row('one', { running: true }), row('two', { running: true })]
  const workspaces = [{ id: 'project-a', sessionIds: ['one'] }, { id: 'project-b', sessionIds: ['two'] }]
  assert.deepEqual(ids(select(rows, { workspaces })), ['one', 'two'])
  assert.deepEqual(ids(select(rows, { workspaces, workspaceId: 'project-b' })), ['two'])
  assert.deepEqual(select(rows, { workspaces, workspaceId: 'missing' }), [])
  assert.deepEqual(select(rows, { workspaces, workspaceId: '' }), [])
})

test('membership, archives and duplicate identities normalize native session prefix', () => {
  const older = row('same', { running: false, updatedAt: now })
  const active = row('session-same', { running: true, updatedAt: 0 })
  const rows = [older, active, row('session-archived', { running: true })]
  const workspaces = [{ id: 'project-a', sessionIds: ['same', 'archived'] }]
  assert.deepEqual(select(rows, { workspaces, archivedSessionIds: ['archived'], range: 'day' }), [active])
})

test('sort is running first, then activity descending, then deterministic id', () => {
  const rows = [row('idle-newest'), row('running-z', { running: true, updatedAt: now - 1 }),
    row('idle-old', { updatedAt: now - 2 }), row('running-b', { running: true, updatedAt: now - 1 }),
    row('running-newest', { running: true, updatedAt: now }), row('idle-a')]
  assert.deepEqual(ids(select(rows, { range: 'hour' })),
    ['running-newest', 'running-b', 'running-z', 'idle-a', 'idle-newest', 'idle-old'])
})

test('missing running timestamps sort deterministically without NaN comparator', () => {
  assert.deepEqual(ids(select([row('z', { running: true, updatedAt: NaN }),
    row('a', { running: true, updatedAt: undefined })])), ['a', 'z'])
})

test('selection never mutates rows, registry membership, archives or input order', () => {
  const rows = Object.freeze([Object.freeze(row('z', { running: true })), Object.freeze(row('a', { running: true }))])
  const workspaces = Object.freeze([Object.freeze({ id: 'project-a', sessionIds: Object.freeze(['z', 'a']) })])
  const archives = Object.freeze([])
  assert.deepEqual(ids(selectSessions({ rows, workspaces, archivedSessionIds: archives, range: 'running', now })), ['a', 'z'])
  assert.deepEqual(ids(rows), ['z', 'a'])
})

test('invalid ranges, recent timestamps and malformed catalog inputs fail closed', () => {
  assert.deepEqual(select([row('one', { running: true })], { range: 'week' }), [])
  assert.deepEqual(select([row('one', { running: true })], { range: 'hour', now: NaN }), [])
  assert.deepEqual(selectSessions(), [])
  assert.deepEqual(selectSessions({ rows: {}, workspaces: [], range: 'running', now }), [])
  assert.deepEqual(select([row('one', { running: true })], { workspaces: [] }), [])
  assert.deepEqual(select([null, {}, row('', { running: true }), row('session-', { running: true })]), [])
})
