import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {apiHandler, ApiError, readJsonObject} from '../lib/api.mjs';
import {requireVerifiedUser} from '../lib/auth.mjs';
import {inspectEnvironment} from '../lib/environment.mjs';
import health from '../api/health.mjs';
import {handleRequest} from '../server.mjs';

const request = (body, headers = {}) => new Request('https://example.test/api/attempts', {
  method: 'POST', headers: {'Content-Type': 'application/json', ...headers}, body
});

test('liveness endpoint has no service credentials or account details', async () => {
  const res = await health.fetch(new Request('https://example.test/api/health', {headers: {'X-Request-ID': 'untrusted'}}));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {status: 'ok', check: 'liveness'});
  assert.match(res.headers.get('x-request-id'), /^[\da-f-]{36}$/);
  assert.notEqual(res.headers.get('x-request-id'), 'untrusted');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('HEAD is empty and unsupported methods get 405 with Allow', async () => {
  const head = await health.fetch(new Request('https://example.test/api/health', {method: 'HEAD'}));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  const post = await health.fetch(new Request('https://example.test/api/health', {method: 'POST'}));
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  assert.equal((await post.json()).error.code, 'method_not_allowed');
});

test('unexpected failures redact both HTTP and logs, even when the logger fails', async () => {
  const logged = [];
  const handler = apiHandler({GET: () => {throw new Error('password=private-test-value');}}, {
    logger: event => logged.push(event)
  });
  const res = await handler.fetch(new Request('https://example.test/?token=private-test-value'));
  assert.equal(res.status, 500);
  assert.equal(logged.length, 1);
  assert.deepEqual(Object.keys(logged[0]).sort(), ['code', 'event', 'requestId']);
  assert.doesNotMatch(JSON.stringify(logged) + await res.text(), /private-test-value|password=|token=/);
  const brokenLogger = apiHandler({GET: () => {throw Error('secret');}}, {logger: () => {throw Error('logging secret');}});
  assert.equal((await brokenLogger.fetch(new Request('https://example.test/'))).status, 500);
});

test('JSON accepts allowed fields and rejects arrays, malformed data and authority injection', async () => {
  const parse = req => readJsonObject(req, {allowedKeys: ['question_id', 'choice', 'uncertain']});
  assert.deepEqual(await parse(request('{"choice":2,"uncertain":true}')), {choice: 2, uncertain: true});
  for (const body of ['null', '[]', '"text"', '{', '{"user_id":"other-account"}', '{"score":100}', '{"__proto__":{}}']) {
    await assert.rejects(parse(request(body)), error => error instanceof ApiError && error.code === 'invalid_request');
  }
  await assert.rejects(parse(request('{}', {'Content-Type': 'text/plain'})), {code: 'unsupported_media_type'});
});

test('body byte limits apply even when Content-Length is missing or forged', async () => {
  const parse = req => readJsonObject(req, {allowedKeys: ['text'], maxBytes: 30});
  await assert.rejects(parse(request(JSON.stringify({text: '長'.repeat(12)}))), {code: 'payload_too_large'});
  await assert.rejects(parse(request(JSON.stringify({text: 'x'.repeat(100)}), {'Content-Length': '1'})), {code: 'payload_too_large'});
  await assert.rejects(parse(request('{}', {'Content-Length': '100'})), {code: 'payload_too_large'});
  await assert.rejects(parse(request('{}', {'Content-Length': 'invalid'})), {code: 'invalid_request'});
});

test('authentication fails closed without a verifier and rejects invalid credentials', async () => {
  const req = new Request('https://example.test/', {headers: {Authorization: 'Bearer forged'}});
  await assert.rejects(requireVerifiedUser(req), {code: 'service_unavailable'});
  await assert.rejects(requireVerifiedUser(req, {verifyAccessToken: async () => null}), {code: 'unauthenticated'});
  await assert.rejects(requireVerifiedUser(req, {verifyAccessToken: async () => {throw Error('secret outage');}}), {code: 'service_unavailable'});
  let calls = 0;
  await assert.rejects(requireVerifiedUser(new Request('https://example.test/'), {
    verifyAccessToken: async () => {calls++; return {id: 'a'};}
  }), {code: 'unauthenticated'});
  assert.equal(calls, 0);
});

test('user identity only comes from server verification, ignoring client user_id', async () => {
  const req = request('{"user_id":"attacker","entitlement":"paid"}', {Authorization: 'Bearer synthetic-token'});
  const user = await requireVerifiedUser(req, {verifyAccessToken: async token => {
    assert.equal(token, 'synthetic-token');
    return {id: 'verified-account', email: 'private@example.test', accessToken: token};
  }});
  assert.deepEqual(user, {id: 'verified-account'});
  assert.ok(Object.isFrozen(user));
});

test('environment validation allows prototype and explicitly distinguishes missing service settings', () => {
  assert.equal(inspectEnvironment({}).valid, true);
  const report = inspectEnvironment({}, {requireServices: ['auth', 'database', 'payments', 'ai']});
  assert.equal(report.valid, false);
  for (const variable of ['SUPABASE_URL', 'DATABASE_URL', 'STRIPE_SECRET_KEY', 'AI_PROVIDER', 'AI_CHAT_RETENTION_DAYS']) {
    assert.ok(report.issues.some(issue => issue.variable === variable));
  }
});

test('preview rejects production data, HTTP origins and conflicting platform configuration', () => {
  const report = inspectEnvironment({
    APP_ENV: 'preview', VERCEL_ENV: 'preview', APP_BASE_URL: 'http://example.test', DATA_ENV: 'production',
    SUPABASE_URL: 'https://project.example.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fake', SUPABASE_SECRET_KEY: 'sb_secret_fake'
  });
  assert.ok(report.issues.some(issue => issue.variable === 'APP_BASE_URL'));
  assert.ok(report.issues.some(issue => issue.variable === 'DATA_ENV'));
  assert.equal(inspectEnvironment({APP_ENV: 'local', VERCEL_ENV: 'production'}).valid, false);
  assert.equal(inspectEnvironment({APP_ENV: 'preview', APP_BASE_URL: 'https://example.test'}).valid, true);
});

test('public secrets and live payment credentials are rejected without echoing values', () => {
  const roleKey = `header.${Buffer.from(JSON.stringify({role: 'service_role'})).toString('base64url')}.signature`;
  const report = inspectEnvironment({
    VITE_SUPABASE_KEY: roleKey, NEXT_PUBLIC_AI_API_KEY: 'private-test-value',
    STRIPE_SECRET_KEY: 'sk_live_private-test-value', PAYMENTS_MODE: 'live', APP_ENV: 'private-test-value'
  });
  assert.equal(report.valid, false);
  for (const variable of ['VITE_SUPABASE_KEY', 'NEXT_PUBLIC_AI_API_KEY', 'STRIPE_SECRET_KEY', 'PAYMENTS_MODE']) {
    assert.ok(report.issues.some(issue => issue.variable === variable));
  }
  assert.doesNotMatch(JSON.stringify(report), /private-test-value|signature/);
});

test('AI requires explicit budgets and retention, without selecting a provider or quota', () => {
  assert.equal(inspectEnvironment({AI_API_KEY: 'fake-private-value'}).valid, false);
  const env = {
    AI_PROVIDER: 'synthetic-provider', AI_API_KEY: 'fake-private-value', AI_MODEL: 'test-model',
    AI_MONTHLY_BUDGET_HKD: '100', AI_ACCOUNT_BUDGET_HKD: '10', AI_CHAT_RETENTION_DAYS: '0'
  };
  assert.equal(inspectEnvironment(env).valid, true);
  assert.equal(inspectEnvironment({...env, AI_ACCOUNT_BUDGET_HKD: '101'}).valid, false);
  assert.equal(inspectEnvironment({...env, AI_CHAT_RETENTION_DAYS: '-1'}).valid, false);
  assert.equal(inspectEnvironment({...env, AI_MONTHLY_BUDGET_HKD: '9'.repeat(400)}).valid, false);
});

test('environment CLI does not print secret values or raw configuration', () => {
  const res = spawnSync(process.execPath, ['scripts/check-environment.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: {APP_ENV: 'private-test-value', STRIPE_SECRET_KEY: 'sk_live_private-test-value'}, encoding: 'utf8'
  });
  assert.equal(res.status, 1);
  assert.doesNotMatch(res.stdout + res.stderr, /private-test-value|sk_live_/);
});

async function localRequest(url, method = 'GET') {
  const res = {status: null, headers: {}, body: null,
    writeHead(status, headers = {}) {this.status = status; this.headers = headers;},
    end(body) {this.body = body;}
  };
  await handleRequest({url, method}, res);
  return res;
}

test('local HTTP routing reaches the API and preserves static GET/HEAD', async () => {
  const healthRes = await localRequest('/api/health');
  assert.equal(healthRes.status, 200);
  assert.deepEqual(JSON.parse(healthRes.body), {status: 'ok', check: 'liveness'});
  assert.equal((await localRequest('/api/health', 'POST')).status, 405);
  assert.equal((await localRequest('/')).status, 200);
  assert.equal((await localRequest('/', 'HEAD')).body, undefined);
  assert.equal((await localRequest('/', 'POST')).status, 405);
  assert.equal((await localRequest('/%2e%2e%2fpackage.json')).status, 404);
});

test('runtime metadata and lockfile agree, and shared library is outside public dist', async () => {
  const [pkg, lock, runtime] = await Promise.all([
    readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../package-lock.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../.nvmrc', import.meta.url), 'utf8')
  ]);
  assert.equal(pkg.engines.node, '24.x');
  assert.equal(runtime.trim(), '24');
  assert.equal(lock.packages[''].engines.node, pkg.engines.node);
  assert.equal(lock.version, pkg.version);
  assert.equal((await localRequest('/lib/auth.mjs')).status, 404);
  assert.equal((await localRequest('/.env.local')).status, 404);
});
