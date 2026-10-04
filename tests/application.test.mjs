import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApplication} from '../lib/application.mjs';
import {createSupabase} from '../lib/supabase.mjs';
import {ApiError} from '../lib/api.mjs';
import {readCookie, sessionCookies} from '../lib/cookies.mjs';

const origin = 'https://study.example.test';
const id = '11111111-1111-4111-8111-111111111111';
const env = {APP_ENV: 'test', APP_BASE_URL: origin, DATA_ENV: 'test', SUPABASE_URL: 'https://project.example.test',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_synthetic', SUPABASE_SECRET_KEY: 'sb_secret_synthetic',
  AUTH_ENABLED: 'true', APP_TERMS_VERSION: 'test-v1', APP_PRIVACY_VERSION: 'test-v1'};
const user = {id, email: 'test@example.test', verified: true};
const session = {access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', expires_in: 3600};
function setup(overrides = {}, envOverrides = {}) {
  const calls = [];
  const provider = {
    auth: async (path, options) => {calls.push({path, options}); return session;},
    adminRpc: async (name, params) => {calls.push({name, params, admin: true}); return {allowed: true, registered: true, consumed: true, prepared: true, userId: id};},
    getUser: async token => {calls.push({getUser: token}); return user;},
    rpc: async (name, params, token) => {calls.push({name, params, token}); return {settings: {track: 'eaqe', examDate: ''}, settingsVersion: 1, events: []};},
    deleteUser: async uid => calls.push({deleteUser: uid}), ...overrides
  };
  return {calls, app: createApplication({env: {...env, ...envOverrides}, provider, logger: () => {}, now: () => 0})};
}
function req(path, body, {method = 'POST', headers = {}, cookie = 'pe_access=synthetic-access; pe_refresh=synthetic-refresh'} = {}) {
  return new Request(origin + path, {method, headers: {Origin: origin, 'X-App-Request': '1', 'X-App-Account': id,
    'Content-Type': 'application/json', Cookie: cookie, ...headers}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
}
const response = async res => ({status: res.status, body: await res.json(), cookies: res.headers.getSetCookie()});

test('unconfigured cloud is explicit and disabled endpoints fail without provider calls', async () => {
  const {app, calls} = setup({}, {AUTH_ENABLED: 'false'});
  const config = await response(await app.fetch(req('/api/config', undefined, {method: 'GET'})));
  assert.equal(config.body.authEnabled, false);
  assert.equal(config.body.authConfigured, true);
  assert.equal((await app.fetch(req('/api/auth/login', {email: user.email, password: 'long-test-password'}))).status, 503);
  assert.equal(calls.length, 0);
  const missing = createApplication({env: {}, logger: () => {}});
  assert.equal((await response(await missing.fetch(req('/api/config', undefined, {method: 'GET'})))).body.authConfigured, false);
});

test('CSRF, input allowlists and stale terms are rejected before side effects', async () => {
  const {app, calls} = setup();
  const payload = {email: user.email, password: 'long-test-password'};
  assert.equal((await app.fetch(req('/api/auth/login', payload, {headers: {Origin: 'https://attacker.test'}}))).status, 403);
  assert.equal((await app.fetch(req('/api/auth/login', payload, {headers: {'X-App-Request': ''}}))).status, 403);
  assert.equal((await app.fetch(req('/api/auth/login', {...payload, user_id: 'attacker'}))).status, 400);
  assert.equal((await app.fetch(req('/api/auth/signup', {...payload, acceptedTerms: true, termsVersion: 'old', privacyVersion: 'test-v1'}))).status, 422);
  assert.equal(calls.length, 0);
});

test('account time comes from the backend clock and ignores client or provider time claims', async () => {
  const {app} = setup({rpc: async () => ({serverTime: '2099-01-01T00:00:00Z', settingsVersion: 1})});
  const res = await response(await app.fetch(req('/api/account', undefined, {method: 'GET', headers: {'X-Client-Time': '2099-01-01T00:00:00Z'}})));
  assert.equal(res.status, 200);
  assert.equal(res.body.serverTime, '1970-01-01T00:00:00.000Z');
  assert.equal(res.body.entitlement, undefined, '尚未接入訂單摘要時不可生成虛構的付費身份');
});

test('signup never creates a session, even if provider verification was misconfigured', async () => {
  const {app, calls} = setup();
  const res = await response(await app.fetch(req('/api/auth/signup', {email: user.email, password: 'long-test-password',
    acceptedTerms: true, termsVersion: 'test-v1', privacyVersion: 'test-v1'})));
  assert.equal(res.status, 200); assert.deepEqual(res.cookies, []); assert.equal(res.body.emailVerificationRequired, true);
  const providerCall = calls.find(c => c.path?.startsWith('/signup'));
  assert.doesNotMatch(JSON.stringify(res.body), /synthetic-access|synthetic-refresh/);
  assert.equal(providerCall.options.body.data.app_terms_version, 'test-v1');
  assert.equal(providerCall.path.includes(encodeURIComponent(origin + '/#auth-callback')), true);
});

test('password login verifies provider user and returns only HttpOnly secure session cookies', async () => {
  const {app, calls} = setup();
  const res = await response(await app.fetch(req('/api/auth/login', {email: user.email, password: 'long-test-password'})));
  assert.equal(res.status, 200); assert.deepEqual(res.body.user, user); assert.equal(res.cookies.length, 2);
  assert.ok(res.cookies.every(c => /HttpOnly/.test(c) && /SameSite=Lax/.test(c) && /; Secure/.test(c)));
  assert.ok(calls.some(c => c.getUser === 'synthetic-access'));
  assert.doesNotMatch(JSON.stringify(res.body), /synthetic-access|synthetic-refresh|long-test-password/);
  const unverified = setup({getUser: async () => ({...user, verified: false})});
  const failure = await response(await unverified.app.fetch(req('/api/auth/login', {email: user.email, password: 'long-test-password'})));
  assert.equal(failure.status, 403); assert.deepEqual(failure.cookies, []);
});

test('per-account service requests fail closed on shared limiter outage or exhaustion', async () => {
  const failing = setup({adminRpc: async () => {throw new ApiError('service_unavailable');}});
  assert.equal((await failing.app.fetch(req('/api/account', undefined, {method: 'GET'}))).status, 503);
  const limited = setup({adminRpc: async () => ({allowed: false})});
  const result = await limited.app.fetch(req('/api/account', undefined, {method: 'GET'}));
  assert.equal(result.status, 429); assert.equal(result.headers.get('retry-after'), '60');
});

test('forget and resend responses do not disclose whether an email exists', async () => {
  const present = setup(), absent = setup({auth: async () => {throw new ApiError('unprocessable');}});
  for (const path of ['/api/auth/forgot', '/api/auth/resend']) {
    const a = await response(await present.app.fetch(req(path, {email: user.email})));
    const b = await response(await absent.app.fetch(req(path, {email: 'missing@example.test'})));
    assert.equal(a.status, 200); assert.deepEqual(a.body, b.body);
  }
});

test('email confirmation works without login cookies and cannot log victim into attacker account', async () => {
  const {app} = setup();
  const result = await response(await app.fetch(req('/api/auth/callback', {tokenHash: 'a'.repeat(64), type: 'signup'}, {cookie: ''})));
  assert.equal(result.status, 200); assert.equal(result.body.emailVerified, true); assert.deepEqual(result.cookies, []);
  assert.equal((await app.fetch(req('/api/auth/callback', {access_token: 'evil', refresh_token: 'evil', type: 'signup'}))).status, 400);
});

test('recovery has a separate cookie and ordinary session is insufficient to reset password', async () => {
  const {app} = setup();
  const callback = await response(await app.fetch(req('/api/auth/callback', {tokenHash: 'a'.repeat(64), type: 'recovery'}, {cookie: ''})));
  assert.equal(callback.cookies.length, 1); assert.match(callback.cookies[0], /^pe_recovery=/);
  assert.equal((await app.fetch(req('/api/auth/reset', {password: 'new-long-password'}))).status, 401);
  const reset = await response(await app.fetch(req('/api/auth/reset', {password: 'new-long-password'}, {cookie: callback.cookies[0].split(';')[0]})));
  assert.equal(reset.status, 200); assert.equal(reset.body.sessionsRevoked, true);
  assert.equal(reset.cookies.length, 3); assert.ok(reset.cookies.every(c => c.includes('Max-Age=0')));
});

test('ordinary JWT renamed as recovery, tampered proof, expired proof and reused nonce cannot reset', async () => {
  const {app, calls} = setup();
  const requestReset = cookie => app.fetch(req('/api/auth/reset', {password: 'new-long-password'}, {cookie}));
  assert.equal((await requestReset('pe_recovery=synthetic-access')).status, 401);
  const callback = await response(await app.fetch(req('/api/auth/callback', {tokenHash: 'a'.repeat(64), type: 'recovery'}, {cookie: ''})));
  const cookie = callback.cookies[0].split(';')[0];
  assert.equal((await requestReset(cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a'))).status, 401);
  const expired = createApplication({env, provider: {
    getUser: async () => {throw Error('must not call provider for expired proof');}
  }, now: () => 601_000, logger: () => {}});
  assert.equal((await expired.fetch(req('/api/auth/reset', {password: 'new-long-password'}, {cookie}))).status, 401);
  const oneTime = setup({adminRpc: async name => {
    if (name === 'app_consume_recovery') return {consumed: false};
    return {allowed: true};
  }});
  assert.equal((await oneTime.app.fetch(req('/api/auth/reset', {password: 'new-long-password'}, {cookie}))).status, 401);
  assert.equal(calls.some(c => c.path === '/user'), false);
});

test('logout does not pretend to succeed if provider revocation fails', async () => {
  const {app} = setup({auth: async () => {throw new ApiError('service_unavailable');}});
  const failed = await response(await app.fetch(req('/api/auth/logout', {})));
  assert.equal(failed.status, 503); assert.deepEqual(failed.cookies, []);
  const expired = setup();
  assert.equal((await expired.app.fetch(req('/api/auth/logout', {}, {cookie: 'pe_refresh=synthetic-refresh'}))).status, 401);
});

test('refresh verifies the new user, rotates cookies and never exposes either credential', async () => {
  const {app, calls} = setup();
  const res = await response(await app.fetch(req('/api/auth/refresh', {})));
  assert.equal(res.status, 200); assert.equal(res.cookies.length, 2);
  assert.ok(calls.some(c => c.path === '/token?grant_type=refresh_token'));
  assert.doesNotMatch(JSON.stringify(res.body), /synthetic-refresh|synthetic-access/);
});

test('deletion requires password reauthentication, explicit confirmation and database policy gate', async () => {
  const {app, calls} = setup();
  assert.equal((await app.fetch(req('/api/account', {password: 'long-test-password', confirmation: 'NO'}, {method: 'DELETE'}))).status, 422);
  assert.equal((await app.fetch(req('/api/account', {password: 'long-test-password', confirmation: 'DELETE'}, {method: 'DELETE'}))).status, 200);
  assert.ok(calls.findIndex(c => c.name === 'app_prepare_delete') < calls.findIndex(c => c.deleteUser));
  const blocked = setup({adminRpc: async name => {if (name === 'app_prepare_delete') throw new ApiError('conflict'); return {allowed: true};}});
  assert.equal((await blocked.app.fetch(req('/api/account', {password: 'long-test-password', confirmation: 'DELETE'}, {method: 'DELETE'}))).status, 409);
  assert.equal(blocked.calls.some(c => c.deleteUser), false);
  assert.equal(calls.find(c => c.name === 'app_prepare_delete').admin, true);
  assert.equal(calls.find(c => c.name === 'app_prepare_delete').params.p_user_id, id);
});

test('attempt API rejects client scoring, bad option/version/time data and only passes allowed payload', async () => {
  const {app, calls} = setup();
  const payload = {eventId: id, sessionId: id, sessionVersion: 1, questionId: 'SYNTHETIC-1', questionVersion: 1, optionId: 'c', uncertain: false};
  assert.equal((await app.fetch(req('/api/attempts', {...payload, correct: true}))).status, 400);
  for (const extra of [{uncertain: 'no'}, {seconds: -1}, {sessionVersion: 0}, {clientOccurredAt: 'bad'}, {optionId: '../answers'}]) {
    assert.equal((await app.fetch(req('/api/attempts', {...payload, ...extra}))).status, 422);
  }
  assert.equal((await app.fetch(req('/api/attempts', payload))).status, 200);
  assert.deepEqual(calls.find(c => c.name === 'app_submit_attempt').params, {p_request: payload});
});

test('settings use explicit expected version; sync uses bounded validated cursor/page', async () => {
  const {app, calls} = setup();
  assert.equal((await app.fetch(req('/api/settings', {expectedVersion: 1, settings: {track: 'eaqe', examDate: '', paid: true}}, {method: 'PUT'}))).status, 422);
  assert.equal((await app.fetch(req('/api/settings', {expectedVersion: 1, settings: {track: 'sqe', examDate: ''}}, {method: 'PUT'}))).status, 200);
  assert.ok(calls.some(c => c.name === 'app_save_settings' && c.params.p_expected_version === 1));
  assert.equal((await app.fetch(req('/api/sync?cursor=-1', undefined, {method: 'GET'}))).status, 422);
  assert.equal((await app.fetch(req('/api/sync?limit=101', undefined, {method: 'GET'}))).status, 422);
  assert.equal((await app.fetch(req('/api/sync?cursor=0&limit=50', undefined, {method: 'GET'}))).status, 200);
});

test('review concepts require the current account and use bounded, track-specific pagination', async () => {
  const {app, calls} = setup();
  const path = '/api/review-concepts?track=sqe&after=PX-SYNTHETIC&limit=10';
  assert.equal((await app.fetch(req(path, undefined, {method: 'GET'}))).status, 200);
  assert.deepEqual(calls.find(call => call.name === 'app_get_review_concepts').params,
    {p_track: 'sqe', p_after: 'PX-SYNTHETIC', p_limit: 10});
  for (const invalid of ['?track=other', '?track=eaqe&limit=51', '?track=eaqe&after=../private', '?track=eaqe&user_id=other']) {
    assert.equal((await app.fetch(req('/api/review-concepts' + invalid, undefined, {method: 'GET'}))).status, 422);
  }
  assert.equal((await app.fetch(req(path, undefined, {method: 'GET', cookie: ''}))).status, 401);
  assert.equal((await app.fetch(req(path, undefined, {method: 'GET', headers: {'X-App-Account': '22222222-2222-4222-8222-222222222222'}}))).status, 409);
});

test('usage validates segment duration and rejects fabricated effective-seconds fields', async () => {
  const {app} = setup();
  const payload = {eventId: id, deviceId: 'synthetic-device', segments: [{id, startAt: '2026-10-04T01:00:00Z', endAt: '2026-10-04T01:01:00Z', kind: 'effective'}]};
  assert.equal((await app.fetch(req('/api/usage', payload))).status, 200);
  assert.equal((await app.fetch(req('/api/usage', {...payload, deviceId: 'x'.repeat(101)}))).status, 422);
  assert.equal((await app.fetch(req('/api/usage', {...payload, segments: [{...payload.segments[0], seconds: 999999}]}))).status, 422);
  assert.equal((await app.fetch(req('/api/usage', {...payload, segments: [{...payload.segments[0], endAt: '2026-10-04T01:30:00Z'}]}))).status, 422);
});

test('cross-tab cookie account change cannot rebind old usage, settings or logout', async () => {
  const other = '22222222-2222-4222-8222-222222222222';
  const {app, calls} = setup({getUser: async () => ({...user, id: other})});
  const usage = {eventId: id, deviceId: 'device-a', segments: [{id, startAt: '2026-10-04T01:00:00Z', endAt: '2026-10-04T01:01:00Z', kind: 'foreground'}]};
  for (const [path, body, method] of [['/api/usage', usage, 'POST'], ['/api/settings', {expectedVersion: 1, settings: {track: 'eaqe', examDate: ''}}, 'PUT'], ['/api/auth/logout', {}, 'POST']]) {
    const res = await response(await app.fetch(req(path, body, {method})));
    assert.equal(res.status, 409); assert.equal(res.body.error.code, 'account_mismatch');
  }
  assert.equal(calls.some(c => c.name === 'app_add_usage' || c.name === 'app_save_settings' || c.path?.startsWith('/logout')), false);
  assert.equal((await app.fetch(req('/api/usage', usage, {headers: {'X-App-Account': ''}}))).status, 422);
  // Bootstrap explicitly discovers the current cookie account; it never mutates the previous user's queue.
  assert.equal((await app.fetch(req('/api/account', undefined, {method: 'GET', headers: {'X-App-Account': ''}}))).status, 200);
});

test('duplicate and malformed cookies are not accepted', () => {
  assert.equal(readCookie(req('/api/account', undefined, {method: 'GET', cookie: 'pe_access=a; pe_access=b'}), 'access'), null);
  assert.equal(readCookie(req('/api/account', undefined, {method: 'GET', cookie: 'pe_access=a%0D%0Aevil'}), 'access'), null);
  assert.throws(() => sessionCookies({access_token: 'line\nbreak', refresh_token: 'r'}, {secure: true}), {code: 'service_unavailable'});
});

test('Supabase adapter distinguishes provider errors, ignores raw secrets and sends only user token to RLS', async () => {
  const calls = [];
  const client = createSupabase({url: env.SUPABASE_URL, publicKey: env.SUPABASE_PUBLISHABLE_KEY, secretKey: env.SUPABASE_SECRET_KEY,
    fetchImpl: async (url, options) => {calls.push({url, options}); return Response.json({message: 'APP_CONFLICT', details: 'secret'}, {status: 400});}});
  await assert.rejects(client.rpc('app_submit_attempt', {p_request: {}}, 'user-token'), {code: 'conflict'});
  assert.equal(calls[0].options.headers.Authorization, 'Bearer user-token');
  assert.equal(calls[0].options.headers.apikey, env.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(calls[0].options.redirect, 'error');
  const broken = createSupabase({url: env.SUPABASE_URL, publicKey: env.SUPABASE_PUBLISHABLE_KEY,
    fetchImpl: async () => Response.json({message: 'db_password=secret'}, {status: 500})});
  await assert.rejects(broken.getUser('token'), error => error.code === 'service_unavailable' && !error.message.includes('secret'));
});
