import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeUser, normalizeUserEntry } from './user-access.js';

// Synthetic IDs and logins only; no credentials or production account data.
const first = 101;
const second = 202;
const login = '@sample_user';
const update = (id = first, username = 'Sample_User') => ({
  id, username, is_bot: false,
});

test('normalize numeric IDs and optional @ usernames case-insensitively', () => {
  for (const input of [first, '101', '00101', ' 101 ']) {
    assert.equal(normalizeUserEntry(input), '101');
  }
  for (const input of [login, 'sample_user', '@SAMPLE_USER', ' Sample_User ']) {
    assert.equal(normalizeUserEntry(input), login);
  }
  assert.equal(normalizeUserEntry(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  assert.equal(normalizeUserEntry('abcde'), '@abcde');
  assert.equal(normalizeUserEntry('a'.repeat(32)), `@${'a'.repeat(32)}`);
});

test('malformed entries fail closed', () => {
  const malformed = [undefined, null, {}, [], true, false, '', ' ', '@',
    0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    '9007199254740992', '0', '-101', '+101', '1e2', '101.0', '@101',
    '@@sample_user', 'sam ple', 'tiny', 'a'.repeat(33), 'ümlaut', '1abcde'];
  for (const entry of malformed) {
    assert.equal(normalizeUserEntry(entry), undefined, String(entry));
    assert.equal(authorizeUser(update(), [entry], {}, { claim: true }), false);
  }
});

test('empty/malformed lists and malformed senders deny', () => {
  for (const entries of [[], null, undefined, {}, login, first]) {
    assert.equal(authorizeUser(update(), entries, {}, { claim: true }), false);
  }
  for (const from of [null, undefined, {}, { id: 0 }, { id: -1 },
    { id: 1.5 }, { id: '1e2' }, { id: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(authorizeUser(from, [first, login], {}, { claim: true }), false);
  }
  assert.equal(authorizeUser(update(), [login], null, { claim: true }), false);
  assert.equal(authorizeUser(update(), [login], Object.freeze({}), { claim: true }), false);
});

test('mixed multiple IDs/logins authorize independently despite invalid entries', () => {
  const entries = [null, first, '303', login, '@Other_User', 'bad login'];
  const pins = {};
  assert.equal(authorizeUser({ id: first }, entries, pins), true);
  assert.equal(authorizeUser({ id: '303' }, entries, pins), true);
  assert.equal(authorizeUser(update(second), entries, pins, { claim: true }), true);
  assert.equal(authorizeUser(update(404, 'OTHER_USER'), entries, pins, { claim: true }), true);
  assert.deepEqual(pins, { '@sample_user': '202', '@other_user': '404' });
  assert.equal(authorizeUser(update(505, 'unknown_user'), entries, pins, { claim: true }), false);
});

test('bot accounts denied even with numeric or pinned grants', () => {
  const pins = { [login]: String(first) };
  const bot = { ...update(), is_bot: true };
  assert.equal(authorizeUser(bot, [first, login], pins, { claim: true }), false);
  assert.equal(authorizeUser(bot, [login], pins), false);
  assert.deepEqual(pins, { [login]: String(first) });
});

for (const kind of ['object', 'Map']) {
  test(`${kind}: first authenticated update claims once; outbound does not claim`, () => {
    const pins = kind === 'Map' ? new Map() : {};
    const snapshot = () => kind === 'Map' ? Object.fromEntries(pins) : { ...pins };
    assert.equal(authorizeUser(update(), [login], pins), false);
    assert.equal(authorizeUser({ id: first }, [login], pins, { claim: true }), false);
    assert.deepEqual(snapshot(), {});
    assert.equal(authorizeUser(update(), ['SAMPLE_USER'], pins, { claim: true }), true);
    assert.deepEqual(snapshot(), { [login]: String(first) });
    assert.equal(authorizeUser(update(first, 'sAmPlE_UsEr'), [login], pins), true);
    assert.equal(authorizeUser({ id: first }, [login], pins), true);
    assert.equal(authorizeUser({ id: second }, [login], pins), false);
    assert.equal(authorizeUser(update(first, 'different_user'), [login], pins), false);
    assert.equal(authorizeUser({ id: first, username: null }, [login], pins), false);
    assert.equal(authorizeUser(update(first, 'different_user'), [first, login], pins), true);
  });

  test(`${kind}: username takeover denied until administrator clears pin`, () => {
    const pins = kind === 'Map' ? new Map([[login, String(first)]]) : { [login]: String(first) };
    const value = () => kind === 'Map' ? pins.get(login) : pins[login];
    assert.equal(authorizeUser(update(second), [login], pins, { claim: true }), false);
    assert.equal(value(), String(first));
    assert.equal(authorizeUser(update(second), [login, second], pins, { claim: true }), true);
    assert.equal(value(), String(first));
    if (kind === 'Map') pins.delete(login);
    else delete pins[login];
    assert.equal(authorizeUser(update(second), [login], pins, { claim: true }), true);
    assert.equal(value(), String(second));
    assert.equal(authorizeUser(update(first), [login], pins, { claim: true }), false);
  });

  test(`${kind}: revoking an allow entry removes update and outbound access immediately`, () => {
    const pins = kind === 'Map' ? new Map([[login, String(first)]]) : { [login]: String(first) };
    for (const entries of [[], ['@other_user'], [second], ['bad login']]) {
      assert.equal(authorizeUser(update(), entries, pins, { claim: true }), false);
      assert.equal(authorizeUser({ id: first }, entries, pins), false);
    }
    assert.equal(authorizeUser({ id: first }, [login], pins), true);
  });
}

test('malformed existing pins cannot be automatically overwritten', () => {
  for (const value of [undefined, null, 0, -1, 'invalid', '9007199254740992']) {
    const pins = { [login]: value };
    assert.equal(authorizeUser(update(), [login], pins, { claim: true }), false);
    assert.equal(pins[login], value);
  }
  const inherited = Object.create({ [login]: String(first) });
  assert.equal(authorizeUser(update(), [login], inherited), false);
});
