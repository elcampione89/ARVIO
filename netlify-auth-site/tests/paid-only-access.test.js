const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { evaluateEntitlement, buildPaidRecord } = require('../netlify/functions/_entitlements');
const trialEmails = require('../netlify/functions/_trial-emails');

function fixture(record = null) {
  const records = new Map(record ? [['account@example.test', record]] : []);
  const events = [];
  let writes = 0;
  let queuedEmails = 0;
  const exports = {};
  const dependencies = {
    './_backend': {
      json: (statusCode, body) => ({ statusCode, body }), options: () => null,
      resolveIdentity: async event => { if (!event.identity) throw Error('unauthorized'); return { email: event.identity }; },
      normalizeEmail: value => String(value || '').trim().toLowerCase(), sha256: value => value
    },
    './_entitlements': {
      entitlementsStore: () => records,
      readEntitlement: async (_store, key) => records.get(key) || null,
      writeEntitlement: async (_store, key, value) => { writes++; records.set(key, value); },
      evaluateEntitlement
    },
    './_premium-funnel': { recordPremiumEvent: async (_event, value) => events.push(value) },
    './_trial-emails': { queueTrialEmails: async () => { queuedEmails++; } }
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../netlify/functions/entitlement-status'), 'utf8'), {
    exports, Buffer, Date, console,
    require: name => { if (!(name in dependencies)) throw Error(`Unexpected dependency ${name}`); return dependencies[name]; }
  });
  const request = overrides => exports.handler({ httpMethod: 'GET', identity: 'account@example.test', ...overrides });
  return { request, records, events, writes: () => writes, queuedEmails: () => queuedEmails };
}

const paid = { status: 'active', source: 'kofi', expiresAt: '2099-01-01', tier: 'Premium', trialUsed: false };
const trial = { status: 'active', source: 'trial', expiresAt: '2099-01-01', trialUsed: true };

test('no account, active trial, expired trial or malformed trial grants hosted access', () => {
  for (const record of [null, trial, { ...trial, expiresAt: '2000-01-01' }, { ...trial, expiresAt: null }, { ...trial, expiresAt: 'broken' }]) {
    const before = JSON.stringify(record);
    const state = evaluateEntitlement(record);
    assert.equal(state.entitled, false);
    assert.equal(state.trialAvailable, false);
    assert.equal(state.trialDurationDays, 0);
    assert.notEqual(state.reason, 'trial');
    assert.equal(JSON.stringify(record), before);
  }
});

test('paid, authorized manual and lifetime access are unchanged; expired paid access stays locked', () => {
  for (const record of [paid, { ...paid, source: 'manual' }, { ...paid, expiresAt: null }]) {
    const state = evaluateEntitlement(record);
    assert.equal(state.entitled, true);
    assert.equal(state.reason, 'subscription');
    assert.equal(state.expiresAt, record.expiresAt);
    assert.equal(state.trialAvailable, false);
  }
  for (const record of [{ ...paid, expiresAt: '2000-01-01' }, { ...paid, expiresAt: 'broken' }, { ...paid, status: 'cancelled' }]) {
    assert.equal(evaluateEntitlement(record).entitled, false);
  }
});

test('legacy trial POST forms are denied without writes, analytics or email jobs', async () => {
  const forms = [
    { body: JSON.stringify({ action: 'start-trial' }) },
    { body: { action: 'START-TRIAL', source: 'kofi', paid: true } },
    { body: '' }, { body: 'not-json' }, {},
    { body: Buffer.from(JSON.stringify({ action: 'start-trial' })).toString('base64'), isBase64Encoded: true }
  ];
  for (const record of [null, trial, { ...trial, expiresAt: '2000-01-01' }, { ...paid, expiresAt: '2000-01-01' }]) {
    const f = fixture(record);
    const before = JSON.stringify([...f.records]);
    for (const form of forms) {
      const result = await f.request({ httpMethod: 'POST', ...form });
      assert.equal(result.statusCode, 403);
      assert.equal(result.body.error, 'trial_unavailable');
      assert.equal(result.body.entitled, false);
      assert.equal(result.body.trialAvailable, false);
    }
    assert.equal(JSON.stringify([...f.records]), before);
    assert.equal(f.writes(), 0);
    assert.equal(f.queuedEmails(), 0);
    assert.equal(f.events.length, 0);
  }
});

test('signed-out trial requests fail authentication, and unknown actions stay rejected', async () => {
  const f = fixture();
  assert.equal((await f.request({ httpMethod: 'POST', identity: null, body: '' })).statusCode, 401);
  assert.equal((await f.request({ httpMethod: 'POST', body: JSON.stringify({ action: 'grant-premium' }) })).statusCode, 400);
  assert.equal((await f.request({ httpMethod: 'DELETE' })).statusCode, 405);
  assert.equal(f.writes(), 0);
});

test('a stale trial request from a paid member cannot downgrade or renew their membership', async () => {
  const f = fixture(paid);
  const result = await f.request({ httpMethod: 'POST', body: '' });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.alreadyEntitled, true);
  assert.equal(result.body.reason, 'subscription');
  assert.equal(result.body.expiresAt, paid.expiresAt);
  assert.equal(f.records.get('account@example.test'), paid);
  assert.equal(f.writes(), 0);
  assert.equal(f.queuedEmails(), 0);
});

test('GET denies a stored trial and only records paid access after a server-owned paid grant', async () => {
  const f = fixture(trial);
  assert.equal((await f.request()).body.entitled, false);
  assert.equal(f.events.length, 0);
  const upgraded = buildPaidRecord(trial, { source: 'kofi', tier: 'Premium', days: 31, event: 'paid' });
  f.records.set('account@example.test', upgraded);
  const result = await f.request();
  assert.equal(result.body.entitled, true);
  assert.equal(result.body.reason, 'subscription');
  assert.equal(result.body.trialAvailable, false);
  assert.equal(f.events[0].eventName, 'paid_access_observed');
  assert.equal(upgraded.trialUsed, true);
});

test('linked Ko-fi renewal still refreshes an expired account copy', async () => {
  const f = fixture({ ...paid, expiresAt: '2000-01-01', linkedFrom: 'billing@example.test', trialUsed: true });
  f.records.set('billing@example.test', paid);
  const result = await f.request();
  assert.equal(result.body.entitled, true);
  assert.equal(result.body.reason, 'subscription');
  assert.equal(result.body.expiresAt, paid.expiresAt);
  assert.equal(f.records.get('account@example.test').trialUsed, true);
  assert.equal(f.writes(), 1);
});

test('legacy callers cannot queue trial emails, even without mail-provider credentials', async () => {
  assert.deepEqual(await trialEmails.queueTrialEmails({}, 'fixture@example.test', '2099-01-01'), []);
});
