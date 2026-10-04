import {ApiError} from './api.mjs';

const names = {access: 'pe_access', refresh: 'pe_refresh', recovery: 'pe_recovery'};
export function readCookie(request, kind) {
  const name = names[kind];
  if (!name) throw TypeError('Unknown cookie');
  const matches = (request.headers.get('cookie') || '').split(';').map(s => s.trim()).filter(s => s.startsWith(name + '='));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return /^[A-Za-z0-9._~-]{1,3800}$/.test(value) ? value : null;
}

export function sessionCookies(session, {secure} = {}) {
  const access = session?.access_token, refresh = session?.refresh_token;
  if (!/^[A-Za-z0-9._~-]{1,3800}$/.test(access || '') || !/^[A-Za-z0-9._~-]{1,3800}$/.test(refresh || '')) {
    throw new ApiError('service_unavailable');
  }
  const suffix = `; Path=/api; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  // Session cookies follow the authentication service's session policy; no arbitrary persistent lifetime.
  return [`${names.access}=${access}${suffix}`, `${names.refresh}=${refresh}${suffix}`];
}

export function clearSessionCookies({secure} = {}) {
  return Object.values(names).map(name => `${name}=; Path=/api; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=0`);
}

export function recoveryCookie(proof, {secure} = {}) {
  if (!/^[A-Za-z0-9._~-]{1,3800}$/.test(proof || '')) throw new ApiError('service_unavailable');
  return `${names.recovery}=${proof}; Path=/api; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=600`;
}

export function jsonWithCookies(body, cookies = [], status = 200) {
  const headers = new Headers();
  cookies.forEach(value => headers.append('Set-Cookie', value));
  return Response.json(body, {status, headers});
}
