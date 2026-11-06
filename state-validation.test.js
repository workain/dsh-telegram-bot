import test from 'node:test'
import assert from 'node:assert/strict'
import { validatePluginState } from './state-validation.js'

function fixture() {
  const binding = { sessionId: 'session-one', chatId: 101, threadId: 7 }
  return {
    version: 3,
    subscription: { userId: 101, chatId: 101, paused: false, workspaceIds: ['project'], generation: 1 },
    sessions: { 'session-one': binding }, threads: { '101:7': 'session-one' },
    updateOffset: 2, updateLedger: { 1: 'done' }, topicAttempts: {},
    watch: { bindings: { '[101,"session-one"]': binding }, bindingErrors: {},
      sessions: { 'session-one': { cursor: 2, handled: [], turns: { 1: { text: 'synthetic' } }, generation: 1 } } },
  }
}

test('valid state preserves forward and reverse identity links', () => {
  assert.doesNotThrow(() => validatePluginState(fixture()))
  assert.doesNotThrow(() => validatePluginState({ version: 3, sessions: {}, threads: {} }))
})

test('cross-session, stale reverse and mismatching observer bindings fail closed', () => {
  for (const damage of [
    state => { state.sessions['session-one'].sessionId = 'session-two' },
    state => { state.threads['101:7'] = 'session-two' },
    state => { state.watch.bindings['[101,"session-one"]'] = { sessionId: 'session-two', chatId: 101, threadId: 7 } },
    state => { state.watch.bindings['[101,"session-one"]'] = { sessionId: 'session-one', chatId: 101, threadId: 8 } },
  ]) {
    const state = fixture(); damage(state)
    assert.throws(() => validatePluginState(state), /Invalid Telegram/)
  }
})

test('malformed subscription, update ledger, attempts and drafts cannot silently reset state', () => {
  for (const damage of [
    state => { state.subscription = [] },
    state => { state.subscription.workspaceIds = 'all' },
    state => { state.updateOffset = -1 },
    state => { state.updateLedger = { 1: 'retry-create' } },
    state => { state.topicAttempts = [] },
    state => { state.watch.sessions['session-one'].turns = [] },
    state => { state.watch.sessions['session-one'].handled = ['2'] },
    state => { state.watch.sessions['session-one'].turns[1].text = {} },
  ]) {
    const state = fixture(); damage(state)
    assert.throws(() => validatePluginState(state), /Invalid Telegram/)
  }
})
