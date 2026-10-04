import {ApiError} from './api.mjs';

const dbErrors = {APP_INVALID: 'unprocessable', APP_CONFLICT: 'conflict', APP_FORBIDDEN: 'forbidden',
  APP_UNVERIFIED: 'forbidden', APP_UNAUTHENTICATED: 'unauthenticated', APP_NOT_FOUND: 'not_found', APP_RATE_LIMIT: 'rate_limited'};
const uuid = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;

export function publicUser(user) {
  if (!user || !uuid.test(user.id || '') || typeof user.email !== 'string' || user.is_anonymous === true ||
      user.banned_until && Date.parse(user.banned_until) > Date.now()) throw new ApiError('unauthenticated');
  return {id: user.id, email: user.email, verified: Boolean(user.email_confirmed_at)};
}

export function createSupabase({url, publicKey, secretKey, fetchImpl = fetch, timeoutMs = 10_000}) {
  async function send(path, {method = 'GET', token, body, privileged = false} = {}) {
    const key = privileged ? secretKey : publicKey;
    if (!url || !key || !path.startsWith('/auth/v1/') && !path.startsWith('/rest/v1/rpc/')) {
      throw new ApiError('service_unavailable');
    }
    const headers = {apikey: key, Accept: 'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    else if (privileged && key.split('.').length === 3) headers.Authorization = `Bearer ${key}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let response, payload;
    try {
      response = await fetchImpl(url + path, {method, headers,
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs)});
      if (response.status === 204) return null;
      const text = await response.text();
      if (text.length > 2_000_000) throw Error();
      payload = JSON.parse(text);
    } catch { throw new ApiError('service_unavailable'); }
    if (!response.ok) {
      if (response.status === 429) throw new ApiError('rate_limited');
      if (response.status >= 500) throw new ApiError('service_unavailable');
      const message = typeof payload?.message === 'string' ? payload.message.split(':')[0].trim() : '';
      if (Object.hasOwn(dbErrors, message)) throw new ApiError(dbErrors[message]);
      if (response.status === 401 || payload?.error_code === 'invalid_credentials' || payload?.error_code === 'session_not_found') {
        throw new ApiError('unauthenticated');
      }
      if (response.status === 403) throw new ApiError('forbidden');
      if (path.startsWith('/rest/') && ['42501', 'PGRST301'].includes(payload?.code)) throw new ApiError('forbidden');
      if (path.startsWith('/rest/')) throw new ApiError('service_unavailable');
      throw new ApiError('unprocessable');
    }
    return payload;
  }
  return {
    auth: (path, options) => send('/auth/v1' + path, options),
    rpc: (name, params = {}, token) => {
      if (!/^app_[a-z_]+$/.test(name)) throw TypeError('Invalid RPC');
      return send('/rest/v1/rpc/' + name, {method: 'POST', token, body: params});
    },
    adminRpc: (name, params = {}) => {
      if (!/^app_[a-z_]+$/.test(name)) throw TypeError('Invalid RPC');
      return send('/rest/v1/rpc/' + name, {method: 'POST', privileged: true, body: params});
    },
    getUser: async token => publicUser(await send('/auth/v1/user', {token})),
    deleteUser: id => {
      if (!uuid.test(id)) throw TypeError('Invalid user ID');
      return send('/auth/v1/admin/users/' + id, {method: 'DELETE', privileged: true});
    }
  };
}
