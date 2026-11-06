/** A definite Bot API rejection is different from an unknown network outcome. */
export function isKnownTelegramRejection(error) {
  return error?.telegram === true && Number.isInteger(error.telegramCode)
    && error.telegramCode >= 400 && error.telegramCode < 500
}

/** Keep the original Bot API outcome when adding a human-readable setup hint. */
export function topicSetupError(error, message) {
  const wrapped = new Error(message, { cause: error })
  wrapped.telegram = error?.telegram === true
  wrapped.telegramCode = error?.telegramCode
  return wrapped
}
