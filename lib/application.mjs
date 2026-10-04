import {createHmac} from 'node:crypto';
import {apiHandler, ApiError, readJsonObject} from './api.mjs';
import {inspectEnvironment} from './environment.mjs';
import {createSupabase} from './supabase.mjs';
import {readCookie, sessionCookies, clearSessionCookies, jsonWithCookies, recoveryCookie} from './cookies.mjs';
import {createRecoveryProof, verifyRecoveryProof, nonceHash} from './recovery.mjs';

const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const emailOf = body => {
  if (typeof body.email !== 'string' || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) throw new ApiError('unprocessable');
  return body.email.trim().toLowerCase();
};
const passwordOf = body => {
  if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) throw new ApiError('unprocessable');
  return body.password;
};
const checkUuid = value => {if (!uuid.test(value || '')) throw new ApiError('unprocessable'); return value;};
const object = value => value && !Array.isArray(value) && typeof value === 'object';
const checkKeys = (value, allowed) => {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k))) throw new ApiError('unprocessable');
};

export function createApplication({env = process.env, fetchImpl, provider, logger, now = () => Date.now()} = {}) {
  let origin = env.APP_BASE_URL || 'http://localhost:5173';
  let secure = false;
  try { const url = new URL(origin); origin = url.origin; secure = url.protocol === 'https:'; } catch {}
  const config = inspectEnvironment(env);
  const configured = config.valid && config.services.auth;
  const enabled = configured && env.AUTH_ENABLED === 'true' && Boolean(env.APP_TERMS_VERSION && env.APP_PRIVACY_VERSION);
  const supabase = provider || createSupabase({url: env.SUPABASE_URL, publicKey: env.SUPABASE_PUBLISHABLE_KEY,
    secretKey: env.SUPABASE_SECRET_KEY, fetchImpl});
  const ready = () => {if (!enabled) throw new ApiError('service_unavailable');};
  const mutation = request => {
    if (request.headers.get('origin') !== origin || request.headers.get('x-app-request') !== '1' ||
        request.headers.get('sec-fetch-site') === 'cross-site') throw new ApiError('forbidden');
  };
  const parse = async (request, keys, maxBytes) => {mutation(request); return readJsonObject(request, {allowedKeys: keys, maxBytes});};
  async function limit(scope, identity, count = 60, seconds = 60) {
    const key = createHmac('sha256', env.SUPABASE_SECRET_KEY || '').update(scope + ':' + identity).digest('hex');
    const result = await supabase.adminRpc('app_rate_limit', {p_key: key, p_limit: count, p_window_seconds: seconds});
    if (result?.allowed !== true) throw new ApiError('rate_limited');
  }
  async function authLimit(scope, email = 'callback') {
    // A global cap and per-address cap are shared in Postgres. No client-supplied IP can bypass them.
    await limit('auth-global-' + scope, 'all', 100, 900);
    await limit('auth-address-' + scope, email, scope === 'login' ? 10 : 3, 900);
  }
  async function authenticated(request) {
    ready();
    const token = readCookie(request, 'access');
    if (!token) throw new ApiError('unauthenticated');
    const user = await supabase.getUser(token);
    const expected = request.headers.get('x-app-account');
    const bootstrap = new URL(request.url).pathname === '/api/account' && request.method === 'GET';
    if (!expected && !bootstrap || expected && !uuid.test(expected)) throw new ApiError('unprocessable');
    if (expected && expected !== user.id) throw new ApiError('account_mismatch');
    await limit('user-api', user.id, 120, 60);
    return {user, token};
  }
  const rpc = async (request, name, params) => {
    const {token} = await authenticated(request);
    return Response.json(await supabase.rpc(name, params, token));
  };
  const routes = {};
  const route = (path, methods) => routes[path] = apiHandler(methods, {logger});
  route('/api/config', {GET: () => Response.json({authEnabled: enabled, authConfigured: configured,
    termsVersion: env.APP_TERMS_VERSION || '', privacyVersion: env.APP_PRIVACY_VERSION || '', passwordMinLength: 12})});
  route('/api/auth/signup', {POST: async request => {
    ready();
    const body = await parse(request, ['email', 'password', 'acceptedTerms', 'termsVersion', 'privacyVersion']);
    const email = emailOf(body), password = passwordOf(body);
    if (body.acceptedTerms !== true || body.termsVersion !== env.APP_TERMS_VERSION || body.privacyVersion !== env.APP_PRIVACY_VERSION) throw new ApiError('unprocessable');
    await authLimit('signup', email);
    await supabase.auth('/signup?redirect_to=' + encodeURIComponent(origin + '/#auth-callback'), {method: 'POST',
      body: {email, password, data: {app_terms_version: env.APP_TERMS_VERSION, app_privacy_version: env.APP_PRIVACY_VERSION}}});
    // Even if email confirmation is disabled in a misconfigured project, signup never sets a session.
    return Response.json({message: '如可建立帳戶，驗證電郵將寄往所填地址。', emailVerificationRequired: true});
  }});
  route('/api/auth/login', {POST: async request => {
    ready();
    const body = await parse(request, ['email', 'password']);
    const email = emailOf(body), password = passwordOf(body);
    await authLimit('login', email);
    const session = await supabase.auth('/token?grant_type=password', {method: 'POST', body: {email, password}});
    const user = await supabase.getUser(session.access_token);
    if (!user.verified) throw new ApiError('forbidden');
    return jsonWithCookies({user, expiresAt: expiry(session, now())}, sessionCookies(session, {secure}));
  }});
  for (const [name, path] of [['forgot', '/recover'], ['resend', '/resend']]) {
    route('/api/auth/' + name, {POST: async request => {
      ready();
      const body = await parse(request, ['email']);
      const email = emailOf(body);
      await authLimit(name, email);
      try {
        await supabase.auth(path + '?redirect_to=' + encodeURIComponent(origin + '/#auth-callback'), {method: 'POST',
          body: {email, ...(name === 'resend' ? {type: 'signup'} : {})}});
      } catch (error) {
        if (!(error instanceof ApiError) || !['unprocessable', 'not_found', 'unauthenticated', 'forbidden'].includes(error.code)) throw error;
      }
      return Response.json({message: '如該地址可接收帳戶電郵，系統將寄出相關連結。'});
    }});
  }
  route('/api/auth/callback', {POST: async request => {
    ready();
    const body = await parse(request, ['tokenHash', 'type']);
    if (!['signup', 'recovery'].includes(body.type) || typeof body.tokenHash !== 'string' || !/^[a-f\d]{32,128}$/i.test(body.tokenHash)) throw new ApiError('unprocessable');
    await authLimit('callback');
    const session = await supabase.auth('/verify', {method: 'POST', body: {token_hash: body.tokenHash, type: body.type}});
    const user = await supabase.getUser(session.access_token);
    if (!user.verified) throw new ApiError('forbidden');
    if (body.type === 'recovery') {
      const {cookie, proof} = createRecoveryProof(session.access_token, user.id, env.SUPABASE_SECRET_KEY, now());
      const registered = await supabase.adminRpc('app_register_recovery', {p_nonce_hash: nonceHash(proof.nonce), p_user_id: user.id,
        p_expires_at: new Date(proof.exp * 1000).toISOString()});
      if (registered?.registered !== true) throw new ApiError('service_unavailable');
      return jsonWithCookies({recoveryReady: true}, [recoveryCookie(cookie, {secure})]);
    }
    // Confirmation works on another device; the user then signs in with their own password.
    await supabase.auth('/logout?scope=local', {method: 'POST', token: session.access_token});
    return Response.json({message: '電郵已驗證，請登入。', emailVerified: true});
  }});
  route('/api/auth/refresh', {POST: async request => {
    ready(); await parse(request, []);
    const refresh = readCookie(request, 'refresh');
    if (!refresh) throw new ApiError('unauthenticated');
    await limit('refresh', createHmac('sha256', env.SUPABASE_SECRET_KEY).update(refresh).digest('hex'), 20, 60);
    const session = await supabase.auth('/token?grant_type=refresh_token', {method: 'POST', body: {refresh_token: refresh}});
    const user = await supabase.getUser(session.access_token);
    if (!user.verified) throw new ApiError('forbidden');
    const expected = request.headers.get('x-app-account');
    if (expected && expected !== user.id) throw new ApiError('account_mismatch');
    return jsonWithCookies({user, expiresAt: expiry(session, now())}, sessionCookies(session, {secure}));
  }});
  route('/api/auth/reset', {POST: async request => {
    ready();
    const body = await parse(request, ['password']);
    const password = passwordOf(body);
    const proof = verifyRecoveryProof(readCookie(request, 'recovery'), env.SUPABASE_SECRET_KEY, now());
    const token = proof.token, user = await supabase.getUser(token);
    if (user.id !== proof.userId || !user.verified) throw new ApiError('unauthenticated');
    await limit('reset', user.id, 3, 900);
    const consumed = await supabase.adminRpc('app_consume_recovery', {p_nonce_hash: nonceHash(proof.nonce), p_user_id: user.id});
    if (consumed?.consumed !== true) throw new ApiError('unauthenticated');
    await supabase.auth('/user', {method: 'PUT', token, body: {password}});
    let sessionsRevoked = true;
    try { await supabase.auth('/logout?scope=global', {method: 'POST', token}); }
    catch { sessionsRevoked = false; }
    return jsonWithCookies({message: '密碼已更新，請重新登入。', sessionsRevoked}, clearSessionCookies({secure}));
  }});
  route('/api/auth/logout', {POST: async request => {
    ready(); await parse(request, []);
    const token = readCookie(request, 'access');
    const expected = request.headers.get('x-app-account');
    if (!uuid.test(expected || '')) throw new ApiError('unprocessable');
    if (token) {
      const user = await supabase.getUser(token);
      if (expected !== user.id) throw new ApiError('account_mismatch');
      try { await supabase.auth('/logout?scope=local', {method: 'POST', token}); }
      catch (error) {if (!(error instanceof ApiError) || error.code !== 'unauthenticated') throw error;}
    } else if (readCookie(request, 'refresh')) {
      // A missing/expired access token is not evidence that the refresh session was revoked.
      throw new ApiError('unauthenticated');
    }
    return jsonWithCookies({loggedOut: true}, clearSessionCookies({secure}));
  }});
  route('/api/account', {
    GET: async request => {
      const {user, token} = await authenticated(request);
      return Response.json({user, ...await supabase.rpc('app_get_account', {}, token), serverTime: new Date(now()).toISOString()});
    },
    DELETE: async request => {
      const body = await parse(request, ['password', 'confirmation']);
      if (body.confirmation !== 'DELETE') throw new ApiError('unprocessable');
      const password = passwordOf(body), {user, token} = await authenticated(request);
      await limit('delete-account', user.id, 3, 900);
      const session = await supabase.auth('/token?grant_type=password', {method: 'POST', body: {email: user.email, password}});
      const reauthenticated = await supabase.getUser(session.access_token);
      if (reauthenticated.id !== user.id) throw new ApiError('forbidden');
      // The database freezes deletion intent and refuses financial-account deletion until policy is defined.
      const prepared = await supabase.adminRpc('app_prepare_delete', {p_user_id: user.id});
      if (prepared?.prepared !== true || prepared?.userId !== user.id) throw new ApiError('service_unavailable');
      await supabase.deleteUser(user.id);
      return jsonWithCookies({deleted: true}, clearSessionCookies({secure}));
    }
  });
  route('/api/settings', {
    GET: async request => {
      const {token} = await authenticated(request), account = await supabase.rpc('app_get_account', {}, token);
      return Response.json({settings: account.settings, settingsVersion: account.settingsVersion});
    },
    PUT: async request => {
      const body = await parse(request, ['expectedVersion', 'settings']);
      checkKeys(body.settings, ['track', 'examDate']);
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 0 || !['eaqe', 'sqe'].includes(body.settings.track) ||
          typeof body.settings.examDate !== 'string' || body.settings.examDate && !/^\d{4}-\d{2}-\d{2}$/.test(body.settings.examDate)) throw new ApiError('unprocessable');
      return rpc(request, 'app_save_settings', {p_expected_version: body.expectedVersion, p_settings: body.settings});
    }
  });
  route('/api/sync', {GET: async request => {
    const url = new URL(request.url), cursor = url.searchParams.get('cursor') || '0', value = url.searchParams.get('limit') || '100';
    if (!/^\d{1,18}$/.test(cursor) || !/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 100 ||
      Array.from(url.searchParams.keys()).some(key => !['cursor', 'limit'].includes(key))) throw new ApiError('unprocessable');
    return rpc(request, 'app_sync', {p_cursor: cursor, p_limit: Number(value)});
  }});
  route('/api/practice-sessions', {
    POST: async request => {
      const body = await parse(request, ['eventId', 'track', 'mode', 'questionIds', 'count', 'part']);
      checkUuid(body.eventId);
      if (!['eaqe', 'sqe'].includes(body.track) || !['practice', 'review'].includes(body.mode) ||
        body.count !== undefined && (!Number.isInteger(body.count) || body.count < 1 || body.count > 50) ||
        body.part !== undefined && (!Number.isInteger(body.part) || body.part < 1 || body.part > 8) ||
        body.questionIds !== undefined && (!Array.isArray(body.questionIds) || body.questionIds.length < 1 || body.questionIds.length > 50 ||
          new Set(body.questionIds).size !== body.questionIds.length || body.questionIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)))) throw new ApiError('unprocessable');
      return rpc(request, 'app_create_session', {p_request: body});
    },
    GET: async request => {
      const url = new URL(request.url), id = checkUuid(url.searchParams.get('id'));
      if (Array.from(url.searchParams.keys()).some(key => key !== 'id')) throw new ApiError('unprocessable');
      return rpc(request, 'app_get_session', {p_session_id: id});
    },
    PATCH: async request => {
      const body = await parse(request, ['sessionId', 'expectedVersion']);
      checkUuid(body.sessionId);
      if (!Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw new ApiError('unprocessable');
      return rpc(request, 'app_advance_session', {p_session_id: body.sessionId, p_expected_version: body.expectedVersion});
    }
  });
  route('/api/attempts', {POST: async request => {
    const body = await parse(request, ['eventId', 'sessionId', 'sessionVersion', 'questionId', 'questionVersion', 'optionId', 'uncertain', 'seconds', 'clientOccurredAt']);
    checkUuid(body.eventId); checkUuid(body.sessionId);
    if (!Number.isSafeInteger(body.sessionVersion) || body.sessionVersion < 1 || typeof body.questionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.questionId) ||
      !Number.isInteger(body.questionVersion) || body.questionVersion < 1 || typeof body.optionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.optionId) ||
      typeof body.uncertain !== 'boolean' || body.seconds !== undefined && body.seconds !== null && (!Number.isInteger(body.seconds) || body.seconds < 0 || body.seconds > 10_800) ||
      body.clientOccurredAt !== undefined && (typeof body.clientOccurredAt !== 'string' || !Number.isFinite(Date.parse(body.clientOccurredAt)))) throw new ApiError('unprocessable');
    return rpc(request, 'app_submit_attempt', {p_request: body});
  }});
  route('/api/review-events', {POST: async request => {
    const body = await parse(request, ['eventId', 'attemptId']); checkUuid(body.eventId); checkUuid(body.attemptId);
    return rpc(request, 'app_mark_uncertain', {p_request: body});
  }});
  route('/api/review-concepts', {GET: async request => {
    const url = new URL(request.url), track = url.searchParams.get('track'), after = url.searchParams.get('after') || '', value = url.searchParams.get('limit') || '50';
    if (!['eaqe', 'sqe'].includes(track) || after && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(after) || !/^\d{1,2}$/.test(value) ||
        Number(value) < 1 || Number(value) > 50 || Array.from(url.searchParams.keys()).some(key => !['track', 'after', 'limit'].includes(key))) throw new ApiError('unprocessable');
    return rpc(request, 'app_get_review_concepts', {p_track: track, p_after: after, p_limit: Number(value)});
  }});
  route('/api/usage', {POST: async request => {
    const body = await parse(request, ['eventId', 'deviceId', 'segments'], 65_536);
    checkUuid(body.eventId);
    if (typeof body.deviceId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.deviceId) || !Array.isArray(body.segments) || body.segments.length < 1 || body.segments.length > 100) throw new ApiError('unprocessable');
    for (const segment of body.segments) {
      checkKeys(segment, ['id', 'startAt', 'endAt', 'kind']); checkUuid(segment.id);
      if (!['foreground', 'effective'].includes(segment.kind) || typeof segment.startAt !== 'string' || typeof segment.endAt !== 'string' ||
        !Number.isFinite(Date.parse(segment.startAt)) || !Number.isFinite(Date.parse(segment.endAt)) || Date.parse(segment.endAt) <= Date.parse(segment.startAt) ||
        Date.parse(segment.endAt) - Date.parse(segment.startAt) > 300_000) throw new ApiError('unprocessable');
    }
    return rpc(request, 'app_add_usage', {p_request: body});
  }});
  route('/api/export', {GET: async request => {
    const {token} = await authenticated(request);
    return Response.json(await supabase.rpc('app_export', {}, token), {headers: {'Content-Disposition': 'attachment; filename="study-records.json"'}});
  }});
  const missing = apiHandler({GET: () => {throw new ApiError('not_found');}, POST: () => {throw new ApiError('not_found');}}, {logger});
  return {fetch(request) {return (routes[new URL(request.url).pathname] || missing).fetch(request);}};
}

function expiry(session, now) {
  const seconds = Number(session.expires_in);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) throw new ApiError('service_unavailable');
  return new Date(now + seconds * 1000).toISOString();
}
