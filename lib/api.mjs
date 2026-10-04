import {randomUUID} from 'node:crypto';

const errors = Object.freeze({
  invalid_request: [400, '請求資料不正確。'],
  unauthenticated: [401, '請先登入。'],
  forbidden: [403, '未獲授權。'],
  not_found: [404, '找不到所需紀錄。'],
  conflict: [409, '紀錄已變更，請重新載入後再試。'],
  account_mismatch: [409, '登入帳戶已變更，請重新載入後再同步。'],
  unprocessable: [422, '提交內容未符合要求。'],
  rate_limited: [429, '操作過於頻繁，請稍後再試。'],
  method_not_allowed: [405, '不支援此操作。'],
  payload_too_large: [413, '提交內容超出限制。'],
  unsupported_media_type: [415, '請以 JSON 格式提交。'],
  service_unavailable: [503, '服務暫時無法使用，請稍後再試。'],
  internal_error: [500, '系統暫時無法處理，請稍後再試。']
});

export class ApiError extends Error {
  constructor(code) {
    if (!Object.hasOwn(errors, code)) throw new TypeError('Unknown API error code');
    super(code);
    this.name = 'ApiError';
    this.code = code;
  }
}

// 日誌只有錯誤碼與伺服器產生的 ID，不包含輸入、token 或例外訊息。
const defaultLogger = event => console.error(JSON.stringify(event));

export function apiHandler(methods, {logger = defaultLogger} = {}) {
  const allowed = Object.keys(methods);
  if (!allowed.length || allowed.some(method =>
    !/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method) || typeof methods[method] !== 'function'
  )) throw new TypeError('Invalid HTTP handlers');

  return {
    async fetch(request) {
      const requestId = randomUUID();
      let response;
      try {
        if (!Object.hasOwn(methods, request.method)) throw new ApiError('method_not_allowed');
        response = await methods[request.method](request, {requestId});
        if (!(response instanceof Response)) throw new TypeError('Handler must return a Response');
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'internal_error';
        const [status, message] = errors[code];
        if (status >= 500) {
          // 告警本身失效不能讓秘密例外內容落入 HTTP 回覆。
          try { logger({event: 'api_error', code, requestId}); } catch {}
        }
        response = Response.json({error: {code, message}, requestId}, {
          status,
          headers: status === 405 ? {Allow: allowed.join(', ')} : status === 429 ? {'Retry-After': '60'} : {}
        });
      }
      const headers = new Headers(response.headers);
      headers.set('X-Request-ID', requestId);
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Cache-Control', 'no-store');
      return new Response(request.method === 'HEAD' ? null : response.body, {
        status: response.status, statusText: response.statusText, headers
      });
    }
  };
}

export async function readJsonObject(request, {allowedKeys, maxBytes = 16_384} = {}) {
  if (!Array.isArray(allowedKeys) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('An input allowlist and positive body limit are required');
  }
  const type = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError('unsupported_media_type');
  const length = request.headers.get('content-length');
  if (length !== null) {
    if (!/^\d+$/.test(length)) throw new ApiError('invalid_request');
    if (Number(length) > maxBytes) throw new ApiError('payload_too_large');
  }
  if (!request.body) throw new ApiError('invalid_request');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new ApiError('payload_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError('invalid_request');
  }
  if (!body || Array.isArray(body) || typeof body !== 'object' ||
      Object.keys(body).some(key => !allowedKeys.includes(key))) throw new ApiError('invalid_request');
  return body;
}
