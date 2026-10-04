// Pure, provider-independent contracts. These functions never contact a payment
// service, verify signatures, persist an order/event, or create an access grant.
export const sittingTrialPlan = Object.freeze({
  id: 'sitting-trial-hkd359-v1', amountMinor: 35900, currency: 'HKD',
  mode: 'one_time', preExamDays: 60, postExamDays: 10
});
const day = 86400000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const utc = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
export class PaymentContractError extends Error {
  constructor(code) { super(code); this.name = 'PaymentContractError'; this.code = code; }
}
function fail(code = 'payment_invalid') { throw new PaymentContractError(code); }
function record(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.getOwnPropertyNames(value).some(key => !allowed.includes(key)) || Object.getOwnPropertySymbols(value).length || required.some(key => !own(value, key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => own(descriptor, 'get') || own(descriptor, 'set'))) fail();
  return value;
}
function text(value, max = 120) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail();
  return value;
}
function identifier(value) { if (typeof value !== 'string' || !uuid.test(value)) fail(); return value; }
function time(value) {
  if (typeof value !== 'string' || !utc.test(value)) fail('payment_invalid_time');
  const date = new Date(value), canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== canonical) fail('payment_invalid_time');
  return {ms: date.getTime(), iso: canonical};
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('payment_unverified_sitting');
  const date = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail('payment_unverified_sitting');
  return value;
}
function environment(value) { if (!['test', 'live'].includes(value)) fail('payment_environment'); return value; }
function track(value) { if (!['eaqe', 'sqe'].includes(value)) fail(); return value; }
function officialSource(value) {
  text(value, 1000);
  let url; try { url = new URL(value); } catch { fail('payment_unverified_sitting'); }
  const host = url.hostname;
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !['eaa.org.hk', 'peak.edu.hk', 'vtc.edu.hk'].some(domain => host === domain || host.endsWith('.' + domain))) fail('payment_unverified_sitting');
  return url.href;
}

// Registry and clock are trusted server context, not fields in a browser body.
// A boolean here records an official-source review; it cannot perform that review.
function verifiedSitting(verifiedSittings, id, selectedTrack, now) {
  if (!Array.isArray(verifiedSittings) || !verifiedSittings.length) fail('payment_unverified_sitting');
  const matches = verifiedSittings.filter(value => value?.id === id);
  if (matches.length !== 1) fail('payment_unverified_sitting');
  const value = record(matches[0], ['id', 'track', 'startsAt', 'endsAt', 'verified', 'verifiedDate', 'sourceUrl', 'status']);
  if (value.verified !== true) fail('payment_unverified_sitting');
  if (value.status !== 'scheduled') fail('payment_unavailable_sitting');
  if (track(value.track) !== selectedTrack) fail('payment_sitting_mismatch');
  const verifiedDate = calendarDate(value.verifiedDate);
  // Hong Kong has no DST; comparison uses the server clock's Hong Kong date.
  if (verifiedDate > new Date(now.ms + 8 * 3600000).toISOString().slice(0, 10)) fail('payment_unverified_sitting');
  const starts = time(value.startsAt), ends = time(value.endsAt);
  if (ends.ms <= starts.ms) fail('payment_invalid_time');
  return {id: text(value.id, 80), track: value.track, startsAt: starts.iso, endsAt: ends.iso,
    verifiedDate, sourceUrl: officialSource(value.sourceUrl)};
}
export function sittingAccessWindow(sitting) {
  record(sitting, ['startsAt', 'endsAt']);
  const starts = time(sitting.startsAt), ends = time(sitting.endsAt);
  if (ends.ms <= starts.ms) fail('payment_invalid_time');
  const opens = new Date(starts.ms - sittingTrialPlan.preExamDays * day).toISOString();
  const expires = new Date(ends.ms + sittingTrialPlan.postExamDays * day).toISOString();
  time(opens); time(expires);
  return {opensAt: opens, expiresAt: expires};
}
export function accessWindowState(window, now) {
  record(window, ['opensAt', 'expiresAt']);
  const opens = time(window.opensAt), expires = time(window.expiresAt), at = time(now);
  if (expires.ms <= opens.ms) fail('payment_invalid_time');
  return at.ms < opens.ms ? 'not_open' : at.ms >= expires.ms ? 'expired' : 'open';
}

export function createPendingOrder({request, authenticatedUserId, orderId, verifiedSittings, paymentEnvironment, now}) {
  record(request, ['examSittingId', 'track']);
  const at = time(now), selectedTrack = track(request.track);
  const sitting = verifiedSitting(verifiedSittings, text(request.examSittingId, 80), selectedTrack, at);
  const window = sittingAccessWindow({startsAt: sitting.startsAt, endsAt: sitting.endsAt});
  if (accessWindowState(window, at.iso) === 'expired') fail('payment_window_closed');
  return {
    schemaVersion: 1, orderId: identifier(orderId), userId: identifier(authenticatedUserId), status: 'pending_payment',
    planId: sittingTrialPlan.id, amountMinor: sittingTrialPlan.amountMinor, currency: sittingTrialPlan.currency,
    mode: sittingTrialPlan.mode, environment: environment(paymentEnvironment),
    examSittingId: sitting.id, examTrack: sitting.track, examStartsAt: sitting.startsAt, examEndsAt: sitting.endsAt,
    examVerifiedDate: sitting.verifiedDate, examSourceUrl: sitting.sourceUrl,
    accessOpensAt: window.opensAt, accessExpiresAt: window.expiresAt, createdAt: at.iso
  };
}

const orderFields = ['schemaVersion', 'orderId', 'userId', 'status', 'planId', 'amountMinor', 'currency', 'mode', 'environment',
  'examSittingId', 'examTrack', 'examStartsAt', 'examEndsAt', 'examVerifiedDate', 'examSourceUrl', 'accessOpensAt', 'accessExpiresAt', 'createdAt'];
const eventFields = ['eventId', 'orderId', 'paymentId', 'userId', 'amountMinor', 'currency', 'mode', 'environment',
  'examSittingId', 'examTrack', 'paymentStatus', 'paidAt'];

// The caller must already have verified the provider's raw event signature and
// the actual captured payment. A browser success URL is never such evidence.
export function matchVerifiedPaymentEvent({order, event, expectedPaymentId, verifiedSittings, paymentEnvironment, now}) {
  record(order, orderFields); record(event, eventFields);
  const at = time(now), env = environment(paymentEnvironment);
  identifier(order.orderId); identifier(order.userId); identifier(event.orderId); identifier(event.userId);
  text(event.eventId, 200); text(event.paymentId, 200); text(expectedPaymentId, 200);
  // Obtain this reference from the saved provider transaction or a backend
  // retrieval rooted in that saved transaction, never from browser metadata.
  if (event.paymentId !== expectedPaymentId) fail('payment_event_mismatch');
  if (order.schemaVersion !== 1 || order.status !== 'pending_payment' || order.planId !== sittingTrialPlan.id ||
      order.amountMinor !== sittingTrialPlan.amountMinor || order.currency !== sittingTrialPlan.currency || order.mode !== sittingTrialPlan.mode) fail('payment_order_mismatch');
  if (order.environment !== env || event.environment !== env) fail('payment_environment');
  if (event.paymentStatus !== 'paid') fail('payment_not_paid');
  for (const field of ['orderId', 'userId', 'amountMinor', 'currency', 'mode', 'examSittingId', 'examTrack']) {
    if (event[field] !== order[field]) fail('payment_event_mismatch');
  }
  const sitting = verifiedSitting(verifiedSittings, text(order.examSittingId, 80), track(order.examTrack), at);
  if (sitting.startsAt !== order.examStartsAt || sitting.endsAt !== order.examEndsAt) fail('payment_sitting_changed');
  calendarDate(order.examVerifiedDate); officialSource(order.examSourceUrl);
  const window = sittingAccessWindow({startsAt: sitting.startsAt, endsAt: sitting.endsAt});
  if (order.accessOpensAt !== window.opensAt || order.accessExpiresAt !== window.expiresAt) fail('payment_order_mismatch');
  const created = time(order.createdAt), paid = time(event.paidAt);
  if (created.ms > at.ms || paid.ms < created.ms || paid.ms > at.ms || created.ms >= time(window.expiresAt).ms) fail('payment_invalid_time');
  return {
    decision: 'matched_payment_evidence', eventId: event.eventId, paymentId: event.paymentId, orderId: order.orderId,
    userId: order.userId, examSittingId: order.examSittingId, examTrack: order.examTrack, environment: env,
    amountMinor: order.amountMinor, currency: order.currency, mode: order.mode, paidAt: paid.iso,
    accessWindow: window, windowState: accessWindowState(window, at.iso),
    requiresAtomicPersistence: true, authorizationCreated: false
  };
}
