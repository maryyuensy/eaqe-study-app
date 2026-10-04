import {createHmac, createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {ApiError} from './api.mjs';

const sign = (payload, secret) => createHmac('sha256', secret).update('password-recovery-v1:' + payload).digest('base64url');
export const nonceHash = nonce => createHash('sha256').update(nonce).digest('hex');

export function createRecoveryProof(token, userId, secret, now = Date.now()) {
  if (!secret || !/^[A-Za-z0-9._~-]{1,2800}$/.test(token || '')) throw new ApiError('service_unavailable');
  const proof = {v: 1, token, userId, nonce: randomBytes(32).toString('base64url'), exp: Math.floor(now / 1000) + 600};
  const encoded = Buffer.from(JSON.stringify(proof)).toString('base64url');
  const cookie = encoded + '.' + sign(encoded, secret);
  if (cookie.length > 3800) throw new ApiError('service_unavailable');
  return {cookie, proof};
}

export function verifyRecoveryProof(cookie, secret, now = Date.now()) {
  if (!secret || typeof cookie !== 'string' || cookie.length > 3800) throw new ApiError('unauthenticated');
  const [encoded, signature, extra] = cookie.split('.');
  if (!encoded || !signature || extra || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new ApiError('unauthenticated');
  const expected = Buffer.from(sign(encoded, secret)), actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ApiError('unauthenticated');
  let proof;
  try { proof = JSON.parse(Buffer.from(encoded, 'base64url').toString()); } catch { throw new ApiError('unauthenticated'); }
  if (proof.v !== 1 || typeof proof.token !== 'string' || !/^[A-Za-z0-9._~-]{1,2800}$/.test(proof.token) ||
      !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(proof.userId || '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(proof.nonce || '') || !Number.isSafeInteger(proof.exp) ||
      proof.exp <= Math.floor(now / 1000) || proof.exp > Math.floor(now / 1000) + 600) throw new ApiError('unauthenticated');
  return proof;
}
