import {ApiError} from './api.mjs';

// verifyAccessToken 必須由伺服器端供應商接口核實簽署、issuer、audience 及 expiry。
// 此模組不會把 JWT 解碼、瀏覽器 user_id 或測試 entitlement 當作已驗證身份。
export async function requireVerifiedUser(request, {verifyAccessToken} = {}) {
  if (typeof verifyAccessToken !== 'function') throw new ApiError('service_unavailable');
  const authorization = request.headers.get('authorization') ?? '';
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match || match[1].length > 8192) throw new ApiError('unauthenticated');
  let user;
  try {
    user = await verifyAccessToken(match[1]);
  } catch {
    throw new ApiError('service_unavailable');
  }
  if (!user || typeof user.id !== 'string' || !user.id.trim() ||
      user.id.length > 128 || /[\x00-\x20\x7f]/.test(user.id)) throw new ApiError('unauthenticated');
  return Object.freeze({id: user.id});
}
