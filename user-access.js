// No username lookup is performed: only authenticated Telegram update data may
// claim a login. Callers must never use claim=true for synthetic/outbound users.

function numericId(value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? String(number) : undefined;
}

/** Normalize a positive safe numeric ID or a Telegram login (5–32 ASCII chars). */
export function normalizeUserEntry(value) {
  if (typeof value === 'number') return numericId(value);
  if (typeof value !== 'string') return undefined;
  const entry = value.trim();
  if (/^\d+$/.test(entry)) return numericId(entry);
  const login = entry.startsWith('@') ? entry.slice(1) : entry;
  if (!/^[a-z][a-z0-9_]{4,31}$/i.test(login)) return undefined;
  return `@${login.toLowerCase()}`;
}

function pinStore(pins) {
  if (pins instanceof Map) {
    return {
      has: (key) => pins.has(key),
      get: (key) => pins.get(key),
      set: (key, value) => pins.set(key, value),
    };
  }
  if (pins && typeof pins === 'object'
      && (Object.getPrototypeOf(pins) === Object.prototype
        || Object.getPrototypeOf(pins) === null)) {
    return {
      has: (key) => Object.hasOwn(pins, key),
      get: (key) => pins[key],
      set: (key, value) => { pins[key] = value; },
    };
  }
  return undefined;
}

/**
 * Return a boolean authorization decision. entries must be an array; malformed
 * entries are ignored individually. pins is a mutable Map or plain object from
 * canonical login to numeric ID (written as a canonical string).
 *
 * Existing pins are never rebound, even if malformed. Removing an allow entry
 * revokes access immediately without deleting its pin. An administrator must
 * explicitly delete a pin before another ID can claim that login.
 */
export function authorizeUser(from, entries, pins, { claim = false } = {}) {
  if (!from || typeof from !== 'object' || from.is_bot) return false;
  const id = numericId(from.id);
  if (!id || !Array.isArray(entries)) return false;
  const allowed = new Set(entries.map(normalizeUserEntry).filter(Boolean));
  if (allowed.has(id)) return true;
  if (allowed.size === 0) return false;

  const store = pinStore(pins);
  if (!store) return false;
  const hasUsername = from.username !== undefined;
  if (hasUsername) {
    // Telegram's actual username field must contain a login, not a numeric ID.
    const login = normalizeUserEntry(from.username);
    if (!login?.startsWith('@') || !allowed.has(login)) return false;
    if (store.has(login)) return numericId(store.get(login)) === id;
    if (claim !== true) return false;
    try {
      store.set(login, id);
      return store.has(login) && numericId(store.get(login)) === id;
    } catch {
      return false;
    }
  }

  // Outbound callers may only have an ID. Never claim/rebind without a login.
  for (const entry of allowed) {
    if (entry.startsWith('@') && store.has(entry)
        && numericId(store.get(entry)) === id) return true;
  }
  return false;
}
