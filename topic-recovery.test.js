import test from 'node:test'
import assert from 'node:assert/strict'
import { isKnownTelegramRejection, topicSetupError } from './topic-recovery.js'

test('explicit Bot API 4xx rejection is safe to unblock, unknown network or server outcome is not', () => {
  for (const code of [400, 401, 403, 409, 429]) assert.equal(isKnownTelegramRejection({ telegram: true, telegramCode: code }), true)
  for (const error of [new Error('timeout'), { telegram: true }, { telegram: true, telegramCode: 500 }, { telegram: true, telegramCode: '400' }, { telegramCode: 400 }]) {
    assert.equal(isKnownTelegramRejection(error), false)
  }
})

test('friendly topic setup hint preserves the definite rejection identity', () => {
  const rejection = Object.assign(new Error('Topics disabled'), { telegram: true, telegramCode: 400 })
  const wrapped = topicSetupError(rejection, 'Enable Topics in BotFather')
  assert.equal(wrapped.cause, rejection)
  assert.equal(isKnownTelegramRejection(wrapped), true)
  assert.equal(isKnownTelegramRejection(topicSetupError(new Error('timeout'), 'Check connection')), false)
})
