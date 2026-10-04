import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {once} from 'node:events';
import {createApplication} from '../lib/application.mjs';
import {ApiError} from '../lib/api.mjs';
import {createAppServer} from '../server.mjs';

// CI/local disposable DB only. Auth is deliberately a synthetic adapter:
// real HTTP -> application validation -> actual PostgreSQL functions/roles.
// This does not exercise Supabase Auth, SMTP, JWT signatures or PostgREST.
const requested = process.env.RUN_DATABASE_TESTS === '1';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value))}::jsonb`;
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const errorCodes = {APP_INVALID: 'unprocessable', APP_CONFLICT: 'conflict', APP_FORBIDDEN: 'forbidden',
  APP_UNVERIFIED: 'forbidden', APP_UNAUTHENTICATED: 'unauthenticated', APP_NOT_FOUND: 'not_found', APP_RATE_LIMIT: 'rate_limited'};

function psql(sql) {
  assert.equal(process.env.RUN_DATABASE_TESTS, '1', 'Database integration requires explicit opt-in');
  assert.equal(process.env.PGDATABASE, 'app_test', 'Never run this fixture against another database');
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PSQL_BIN || 'psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
      env: {...process.env, PGCONNECT_TIMEOUT: '5'}, stdio: ['pipe', 'pipe', 'pipe']
    });
    let output = '', diagnostic = '', settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); finish(new Error('Synthetic PostgreSQL HTTP fixture timed out'));
    }, 15_000);
    function finish(error, lines) {
      if (settled) return;
      settled = true; clearTimeout(timer); error ? reject(error) : resolve(lines);
    }
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.length > 1_000_000) {child.kill('SIGKILL'); finish(new Error('Unexpected database output size'));}
    });
    child.stderr.on('data', chunk => {diagnostic = (diagnostic + chunk).slice(0, 4000);});
    child.on('error', error => finish(error));
    child.on('exit', code => {
      if (code !== 0) {
        const error = new Error(`Synthetic PostgreSQL HTTP fixture failed: ${diagnostic}`);
        error.databaseCode = diagnostic.match(/\b(APP_[A-Z_]+)\b/)?.[1];
        finish(error);
      } else finish(null, output.trim().split('\n').filter(Boolean));
    });
    child.stdin.on('error', error => finish(error));
    // No shell interpolation or dynamic SQL identifiers. JSON/string arguments
    // are quoted as SQL literals, with standard backslash handling made explicit.
    child.stdin.end(`set standard_conforming_strings=on;\n${sql}\n`);
  });
}
const lastJSON = lines => JSON.parse(lines.filter(line => line.startsWith('{')).at(-1));
const asUser = (identity, sql) => {
  assert.match(identity.user.id, uuid); assert.match(identity.sessionId, uuid);
  return `begin; set local role authenticated;
    set local request.jwt.claim.sub=${quote(identity.user.id)};
    set local request.jwt.claims=${quote(JSON.stringify({sub: identity.user.id, session_id: identity.sessionId, role: 'authenticated'}))};
    ${sql}; commit;`;
};

// Function names/signatures are a fixed allowlist, never an incoming identifier.
const userStatements = {
  app_get_account: () => 'select public.app_get_account()',
  app_create_session: params => `select public.app_create_session(${json(params.p_request)})`,
  app_get_session: params => {
    assert.match(params.p_session_id, uuid);
    return `select public.app_get_session(${quote(params.p_session_id)}::uuid)`;
  },
  app_submit_attempt: params => `select public.app_submit_attempt(${json(params.p_request)})`,
  app_sync: params => {
    assert.match(params.p_cursor, /^\d{1,18}$/); assert.ok(Number.isInteger(params.p_limit) && params.p_limit >= 1 && params.p_limit <= 100);
    return `select public.app_sync(${quote(params.p_cursor)},${params.p_limit})`;
  },
  app_save_settings: params => {
    assert.ok(Number.isSafeInteger(params.p_expected_version) && params.p_expected_version >= 0);
    return `select public.app_save_settings(${params.p_expected_version},${json(params.p_settings)})`;
  }
};

function syntheticAuthDatabaseAdapter(users) {
  const identities = new Map(), limiterKeys = new Set(), calls = [];
  async function identity(token) {
    const found = identities.get(token);
    if (!found) throw new ApiError('unauthenticated');
    return found;
  }
  return {
    calls, limiterKeys,
    async getUser(token) {return (await identity(token)).user;},
    async auth(path, options) {
      assert.equal(path, '/token?grant_type=password', 'Only synthetic password login is implemented');
      assert.equal(options.method, 'POST');
      const user = users.find(value => value.email === options.body.email);
      if (!user || options.body.password !== 'synthetic-http-fixture-password') throw new ApiError('unauthenticated');
      const sessionId = randomUUID(), access = `synthetic-access-${randomUUID()}`, refresh = `synthetic-refresh-${randomUUID()}`;
      await psql(`insert into auth.sessions(id,user_id) values(${quote(sessionId)}::uuid,${quote(user.id)}::uuid);`);
      identities.set(access, {user, sessionId});
      return {access_token: access, refresh_token: refresh, expires_in: 3600};
    },
    async rpc(name, params, token) {
      assert.ok(Object.hasOwn(userStatements, name), 'Unexpected RPC is never interpolated into SQL');
      const who = await identity(token);
      calls.push({name, userId: who.user.id, sessionId: who.sessionId});
      try {return lastJSON(await psql(asUser(who, userStatements[name](params))));}
      catch (error) {
        if (Object.hasOwn(errorCodes, error.databaseCode || '')) throw new ApiError(errorCodes[error.databaseCode]);
        throw error;
      }
    },
    async adminRpc(name, params) {
      assert.equal(name, 'app_rate_limit', 'Only the service-role rate limiter is available to this fixture');
      assert.match(params.p_key, /^[0-9a-f]{64}$/);
      assert.ok(Number.isInteger(params.p_limit) && params.p_limit >= 1 && params.p_limit <= 10000);
      assert.ok(Number.isInteger(params.p_window_seconds) && params.p_window_seconds >= 1 && params.p_window_seconds <= 86400);
      limiterKeys.add(params.p_key);
      return lastJSON(await psql(`begin; set local role service_role;
        select public.app_rate_limit(${quote(params.p_key)},${params.p_limit},${params.p_window_seconds}); commit;`));
    }
  };
}

function device(origin, accountId) {
  const jar = new Map();
  return {
    jar,
    async request(path, {method = 'GET', body, expectedAccount = accountId} = {}) {
      const headers = {Origin: origin, 'X-App-Request': '1', ...(jar.size ? {Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ')} : {}),
        ...(expectedAccount ? {'X-App-Account': expectedAccount} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {})};
      const response = await fetch(origin + path, {method, headers,
        ...(body !== undefined ? {body: JSON.stringify(body)} : {}), redirect: 'error', signal: AbortSignal.timeout(10_000)});
      const cookies = response.headers.getSetCookie();
      for (const cookie of cookies) {
        const [pair] = cookie.split(';'), split = pair.indexOf('='), name = pair.slice(0, split), value = pair.slice(split + 1);
        if (/;\s*Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name); else jar.set(name, value);
      }
      return {status: response.status, body: await response.json(), cookies, headers: response.headers};
    }
  };
}

test('local HTTP application and real PostgreSQL preserve two-device learning and account isolation', {skip: !requested, timeout: 90_000}, async t => {
  assert.equal(process.env.PGDATABASE, 'app_test', 'An explicit disposable app_test database is required');
  const users = ['a', 'b'].map(label => ({id: randomUUID(), email: `http-${label}-${randomUUID()}@example.invalid`, verified: true}));
  const [a, b] = users, questionId = `test-http-${randomUUID().replaceAll('-', '')}`;
  const provider = syntheticAuthDatabaseAdapter(users);
  const fixtureQuestion = {stem: "Synthetic HTTP scenario with 'quoted' input and a \\ backslash.",
    options: Array.from({length: 5}, (_, i) => ({id: `opt_${i + 1}`, text: `Synthetic option ${i + 1}`})),
    explanation: {core: 'Synthetic HTTP concept', apply: 'Synthetic server explanation',
      options: {opt_1: 'Correct synthetic reason', opt_2: 'Wrong synthetic reason', opt_3: 'Wrong synthetic reason', opt_4: 'Wrong synthetic reason', opt_5: 'Wrong synthetic reason'},
      memory: 'Synthetic memory aid'}};
  let application, server;
  try {
    await psql(`begin;
      insert into auth.users(id,email,email_confirmed_at) values ${users.map(user => `(${quote(user.id)}::uuid,${quote(user.email)},now())`).join(',')};
      insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,concept,part,tracks,is_free,rights_status,review_status,published,verified_at)
      values(${quote(questionId)},1,${quote(fixtureQuestion.stem)},${json(fixtureQuestion.options)},'opt_1',${json(fixtureQuestion.explanation)},'Synthetic HTTP concept',1,array['eaqe','sqe'],true,'approved','approved',true,now());
      commit;`);
    server = createAppServer({application: {fetch: request => application.fetch(request)}});
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    application = createApplication({provider, logger: () => {}, env: {
      APP_ENV: 'test', DATA_ENV: 'test', APP_BASE_URL: origin, SUPABASE_URL: 'https://synthetic.example.invalid',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_http_synthetic', SUPABASE_SECRET_KEY: `sb_secret_http_${randomUUID()}`,
      AUTH_ENABLED: 'true', APP_TERMS_VERSION: 'synthetic-v1', APP_PRIVACY_VERSION: 'synthetic-v1'
    }});
    const first = device(origin, a.id), second = device(origin, a.id), other = device(origin, b.id);
    let account, created, accepted, answerRequest;

    await t.test('two HTTP devices receive separate HttpOnly sessions for the same verified synthetic user', async () => {
      for (const [client, user] of [[first, a], [second, a], [other, b]]) {
        const login = await client.request('/api/auth/login', {method: 'POST', body: {email: user.email, password: 'synthetic-http-fixture-password'}});
        assert.equal(login.status, 200); assert.equal(login.body.user.id, user.id);
        assert.equal(login.cookies.length, 2);
        assert.ok(login.cookies.every(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax') && cookie.includes('Path=/api')));
        assert.doesNotMatch(JSON.stringify(login.body), /synthetic-access-|synthetic-refresh-/);
      }
      assert.notEqual(first.jar.get('pe_access'), second.jar.get('pe_access'));
      account = await first.request('/api/account', {expectedAccount: null});
      assert.equal(account.status, 200); assert.equal(account.body.profile.id, a.id);
      assert.ok(account.body.catalog.some(row => row.track === 'eaqe' && row.part === 1 && row.available >= 1));
      const next = await second.request('/api/account');
      assert.equal(next.status, 200); assert.equal(next.body.profile.id, a.id); assert.deepEqual(next.body.settings, account.body.settings);
      assert.equal((await device(origin, null).request('/api/account')).status, 401);
    });

    await t.test('HTTP session creation hides answers; SQL grades a stable shuffled option and synchronizes the wrong answer', async () => {
      created = await first.request('/api/practice-sessions', {method: 'POST', body: {eventId: randomUUID(), track: 'eaqe', mode: 'practice', questionIds: [questionId], count: 1}});
      assert.equal(created.status, 200); assert.equal(created.body.session.items.length, 1);
      assert.equal(created.body.session.items[0].stem, fixtureQuestion.stem);
      assert.deepEqual(new Set(created.body.session.items[0].options.map(option => option.id)), new Set(fixtureQuestion.options.map(option => option.id)));
      assert.doesNotMatch(JSON.stringify(created.body), /answerOptionId|Synthetic server explanation|Wrong synthetic reason/);
      answerRequest = {eventId: randomUUID(), sessionId: created.body.session.id, sessionVersion: created.body.session.version,
        questionId, questionVersion: 1, optionId: 'opt_2', uncertain: false, seconds: 12};
      accepted = await first.request('/api/attempts', {method: 'POST', body: answerRequest});
      assert.equal(accepted.status, 200); assert.equal(accepted.body.attempt.correct, false);
      assert.equal(accepted.body.attempt.id, answerRequest.eventId); assert.equal(accepted.body.attempt.optionId, 'opt_2');
      assert.equal(accepted.body.review.status, 'wrong'); assert.equal(accepted.body.review.successes, 0);
      assert.equal(accepted.body.explanation.answerOptionId, 'opt_1');
      assert.deepEqual(accepted.body.explanation.content, fixtureQuestion.explanation);
      const synced = await second.request('/api/sync?cursor=0&limit=100');
      assert.equal(synced.status, 200);
      const event = synced.body.events.find(value => value.kind === 'attempt');
      assert.deepEqual(event.payload.attempt, accepted.body.attempt); assert.deepEqual(event.payload.review, accepted.body.review);
      const resumed = await second.request(`/api/practice-sessions?id=${created.body.session.id}`);
      assert.equal(resumed.status, 200); assert.deepEqual(resumed.body.session.result, accepted.body.attempt);
    });

    await t.test('another device updates settings; HTTP retries retain one original attempt and cursor', async () => {
      const saved = await second.request('/api/settings', {method: 'PUT', body: {expectedVersion: account.body.settingsVersion, settings: {track: 'sqe', examDate: ''}}});
      assert.equal(saved.status, 200); assert.equal(saved.body.settingsVersion, account.body.settingsVersion + 1);
      const stale = await first.request('/api/settings', {method: 'PUT', body: {expectedVersion: account.body.settingsVersion, settings: {track: 'eaqe', examDate: ''}}});
      assert.equal(stale.status, 409); assert.equal(stale.body.error.code, 'conflict');
      const synced = await first.request('/api/sync?cursor=0&limit=100');
      assert.equal(synced.status, 200); assert.equal(synced.body.settings.track, 'sqe');
      assert.ok(synced.body.events.some(event => event.kind === 'settings' && event.payload.settings.track === 'sqe'));
      const retries = await Promise.all([first, second].map(client => client.request('/api/attempts', {method: 'POST', body: answerRequest})));
      for (const retry of retries) {assert.equal(retry.status, 200); assert.deepEqual(retry.body, accepted.body);}
      const count = await psql(`select count(*) from app_private.attempts where user_id=${quote(a.id)}::uuid and question_id=${quote(questionId)};`);
      assert.equal(count.at(-1), '1');
      const after = await second.request('/api/sync?cursor=' + synced.body.cursor + '&limit=100');
      assert.equal(after.status, 200); assert.deepEqual(after.body.events, []); assert.equal(after.body.cursor, synced.body.cursor);
    });

    await t.test('B cannot read or submit A session; a stale A header with B Cookie is rejected before RPC', async () => {
      const read = await other.request(`/api/practice-sessions?id=${created.body.session.id}`);
      assert.equal(read.status, 404); assert.equal(read.body.error.code, 'not_found');
      assert.doesNotMatch(JSON.stringify(read.body), /Synthetic HTTP|Synthetic server explanation/);
      const write = await other.request('/api/attempts', {method: 'POST', body: {...answerRequest, eventId: randomUUID()}});
      assert.equal(write.status, 404); assert.equal(write.body.error.code, 'not_found');
      const before = provider.calls.length;
      const mismatched = await other.request('/api/settings', {method: 'PUT', expectedAccount: a.id,
        body: {expectedVersion: 1, settings: {track: 'sqe', examDate: ''}}});
      assert.equal(mismatched.status, 409); assert.equal(mismatched.body.error.code, 'account_mismatch');
      assert.equal(provider.calls.length, before, 'Account mismatch must stop before a database user RPC');
      const bState = await other.request('/api/sync?cursor=0&limit=100');
      assert.equal(bState.status, 200); assert.deepEqual(bState.body.events, []); assert.equal(bState.body.settings.track, 'eaqe');
      const count = await psql(`select count(*) from app_private.attempts where user_id=${quote(b.id)}::uuid;`);
      assert.equal(count.at(-1), '0');
    });
  } finally {
    if (server?.listening) {
      server.closeIdleConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    for (const user of users) provider.limiterKeys.add(createHash('sha256').update('learning-user:' + user.id).digest('hex'));
    await psql(`begin;
      delete from auth.users where id in (${users.map(user => `${quote(user.id)}::uuid`).join(',')});
      delete from app_private.question_versions where question_id=${quote(questionId)};
      delete from app_private.rate_limit_windows where key_hash in (${[...provider.limiterKeys].map(quote).join(',')});
      commit;`);
  }
});
