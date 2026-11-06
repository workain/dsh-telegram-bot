import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
function fixture(query, initial = {}) {
  const listeners = new Set(), cleanups = [], opened = [], warnings = []
  let rows = initial, exported, attempts = 0, fail = false
  const window = {
    location: { href: `https://web.example.test/?${query}` },
    history: { state: null, replaceState(_state, _title, url) { window.location.href = String(url) } },
    __ModuleLoader__: { load({ factory }) {
      exported = factory(name => name === 'react' ? { createElement() {} } : {})
    } },
  }
  vm.runInNewContext(source, { window, URL, console: { warn: value => warnings.push(value) } })
  const ctx = {
    locale: { bind: () => key => key }, configForms: { get: () => ({}) },
    effect(fn, label) { if (label === 'telegram: open linked original session') cleanups.push(fn()) },
    sessions: {
      refresh() { throw new Error('Do not race native initial connection') },
      list: { getSnapshot: () => ({ byId: rows }), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) } },
    },
    uiWorkspace: { openSession(id) {
      attempts++
      if (fail) throw new Error('Synthetic view failure')
      opened.push(id)
      // Native view retention may synchronously publish another catalog revision.
      for (const listener of listeners) listener()
    } },
  }
  exported.apply(ctx)
  return { opened, warnings, window, listeners, exported,
    update(next) { rows = next; for (const listener of [...listeners]) listener() },
    dispose() { for (const cleanup of cleanups) cleanup?.() },
    set fail(value) { fail = value }, get attempts() { return attempts },
  }
}

test('deep link waits for native catalog and opens exactly once despite reentrant publication', () => {
  const f = fixture('dshSession=session-synthetic')
  assert.deepEqual(f.opened, [])
  assert.equal(f.listeners.size, 1)
  f.update({ 'session-synthetic': { id: 'session-synthetic' } })
  assert.deepEqual(f.opened, ['session-synthetic'])
  assert.equal(new URL(f.window.location.href).searchParams.has('dshSession'), false)
  f.update({ 'session-synthetic': { id: 'session-synthetic' } })
  assert.equal(f.attempts, 1)
  f.dispose()
  assert.equal(f.listeners.size, 0)
})

test('deep link accepts the canonical native identity without creating a fork or session', () => {
  const f = fixture('dshSession=session-synthetic', { synthetic: { id: 'synthetic' } })
  assert.deepEqual(f.opened, ['synthetic'])
  assert.equal(f.attempts, 1)
  f.dispose()
})

test('unknown session is never opened or converted into a new session', () => {
  const f = fixture('dshSession=unknown', { different: { id: 'different' } })
  assert.equal(f.attempts, 0)
  assert.equal(new URL(f.window.location.href).searchParams.get('dshSession'), 'unknown')
  f.dispose()
  f.update({ unknown: { id: 'unknown' } })
  assert.equal(f.attempts, 0)
})

test('invalid or ambiguous link parameters do not subscribe or change the view', () => {
  for (const query of ['', 'dshSession=', 'dshSession=a&dshSession=b', 'dshSession=a%20b', 'dshSession=a%00b']) {
    const f = fixture(query, { a: { id: 'a' } })
    assert.equal(f.attempts, 0)
    assert.equal(f.listeners.size, 0)
    f.dispose()
  }
})

test('an inherited property is not mistaken for a discovered native session', () => {
  const f = fixture('dshSession=__proto__', {})
  assert.equal(f.attempts, 0)
  f.dispose()
})

test('a view failure keeps the link for retry and logs no address or session content', () => {
  const f = fixture('dshSession=synthetic')
  f.fail = true
  f.update({ synthetic: { id: 'synthetic' } })
  assert.equal(f.opened.length, 0)
  assert.equal(new URL(f.window.location.href).searchParams.has('dshSession'), true)
  assert.deepEqual(f.warnings, ['Telegram session link could not be opened'])
  f.fail = false
  f.update({ synthetic: { id: 'synthetic' } })
  assert.deepEqual(f.opened, ['synthetic'])
  f.dispose()
})
