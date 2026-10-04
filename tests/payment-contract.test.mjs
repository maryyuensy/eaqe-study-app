import test from 'node:test';
import assert from 'node:assert/strict';
import {createPendingOrder, matchVerifiedPaymentEvent, sittingAccessWindow, accessWindowState, sittingTrialPlan, PaymentContractError} from '../lib/payment-contract.mjs';

// Dates/IDs below are a synthetic registry fixture, not published exam sittings.
const userId = '11111111-1111-4111-8111-111111111111';
const otherUser = '22222222-2222-4222-8222-222222222222';
const orderId = '33333333-3333-4333-8333-333333333333';
const sitting = {id: 'synthetic-official-fixture', track: 'eaqe', startsAt: '2035-12-15T06:30:00Z', endsAt: '2035-12-15T09:30:00Z',
  verified: true, verifiedDate: '2035-10-01', sourceUrl: 'https://www.eaa.org.hk/zh-hk/Examination/Registration-details-post-registration-matters', status: 'scheduled'};
const context = () => ({request: {examSittingId: sitting.id, track: sitting.track}, authenticatedUserId: userId, orderId,
  verifiedSittings: [structuredClone(sitting)], paymentEnvironment: 'test', now: '2035-10-04T04:00:00Z'});
const order = () => createPendingOrder(context());
const paymentEvent = value => ({eventId: 'synthetic-paid-event', orderId: value.orderId, paymentId: 'synthetic-paid-payment', userId: value.userId,
  amountMinor: value.amountMinor, currency: value.currency, mode: value.mode, environment: value.environment,
  examSittingId: value.examSittingId, examTrack: value.examTrack, paymentStatus: 'paid', paidAt: '2035-10-04T04:01:00Z'});
const matchContext = () => { const value = order(); return {order: value, event: paymentEvent(value), expectedPaymentId: 'synthetic-paid-payment', verifiedSittings: [structuredClone(sitting)], paymentEnvironment: 'test', now: '2035-10-04T04:02:00Z'}; };
const error = code => value => value instanceof PaymentContractError && value.code === code;

test('pending order is bound to server identity, fixed price and an explicitly verified sitting', () => {
  const value = order();
  assert.equal(value.userId, userId); assert.equal(value.orderId, orderId);
  assert.equal(value.amountMinor, 35900); assert.equal(value.currency, 'HKD'); assert.equal(value.mode, 'one_time');
  assert.equal(value.status, 'pending_payment'); assert.equal(value.examSittingId, sitting.id);
  assert.equal(value.examStartsAt, '2035-12-15T06:30:00.000Z');
  assert.equal(value.accessOpensAt, '2035-10-16T06:30:00.000Z');
  assert.equal(value.accessExpiresAt, '2035-12-25T09:30:00.000Z');
  assert.ok(Object.isFrozen(sittingTrialPlan));
});

test('request rejects customer price, identity, mode, arbitrary dates and unknown fields even when they look correct', () => {
  for (const extra of [{amountMinor: 35900}, {currency: 'HKD'}, {userId}, {orderId}, {mode: 'one_time'}, {paymentEnvironment: 'test'},
    {date: '2035-12-15'}, {examStartsAt: sitting.startsAt}, {paid: true}, {accessTracks: ['eaqe', 'sqe']}]) {
    const value = context(); value.request = {...value.request, ...extra};
    assert.throws(() => createPendingOrder(value), error('payment_invalid'));
  }
});

test('unverified, absent, ambiguous, cancelled or foreign-track sitting is rejected', () => {
  const variants = [
    value => { value.request.examSittingId = 'EAQE-20351215'; },
    value => { value.verifiedSittings = []; },
    value => { value.verifiedSittings.push(structuredClone(sitting)); },
    value => { value.verifiedSittings[0].verified = false; },
    value => { value.verifiedSittings[0].status = 'cancelled'; },
    value => { value.request.track = 'sqe'; },
    value => { value.verifiedSittings[0].verifiedDate = '2035-10-05'; },
    value => { value.verifiedSittings[0].sourceUrl = 'https://eaa.org.hk.attacker.invalid/exams'; },
    value => { value.verifiedSittings[0].sourceUrl = 'http://www.eaa.org.hk/exams'; }
  ];
  for (const mutate of variants) {const value = context(); mutate(value); assert.throws(() => createPendingOrder(value), PaymentContractError);}
});

test('timestamps must be real UTC instants and the exam must end after it begins', () => {
  for (const now of ['2035-02-30T04:00:00Z', '2035-10-04T04:00:00+08:00', '2035-10-04', '2035-10-04T24:00:00Z', 'not-a-date']) {
    assert.throws(() => createPendingOrder({...context(), now}), error('payment_invalid_time'));
  }
  for (const endsAt of [sitting.startsAt, '2035-12-15T06:29:59Z']) {
    const value = context(); value.verifiedSittings[0].endsAt = endsAt;
    assert.throws(() => createPendingOrder(value), error('payment_invalid_time'));
  }
  assert.throws(() => createPendingOrder({...context(), authenticatedUserId: [userId]}), error('payment_invalid'));
});

test('window boundaries are inclusive at opening and exclusive at expiry; they preserve the official exam duration', () => {
  const window = sittingAccessWindow({startsAt: sitting.startsAt, endsAt: sitting.endsAt});
  assert.equal(accessWindowState(window, '2035-10-16T06:29:59.999Z'), 'not_open');
  assert.equal(accessWindowState(window, window.opensAt), 'open');
  assert.equal(accessWindowState(window, '2035-12-25T09:29:59.999Z'), 'open');
  assert.equal(accessWindowState(window, window.expiresAt), 'expired');
  assert.equal(Date.parse(window.expiresAt) - Date.parse(window.opensAt), 70 * 86400000 + 3 * 3600000);
  assert.throws(() => createPendingOrder({...context(), now: window.expiresAt}), error('payment_window_closed'));
});

test('Hong Kong leap-day and midnight cases preserve exact UTC boundaries', () => {
  const window = sittingAccessWindow({startsAt: '2028-02-29T16:00:00Z', endsAt: '2028-02-29T18:30:00Z'});
  assert.equal(window.opensAt, '2027-12-31T16:00:00.000Z');
  assert.equal(window.expiresAt, '2028-03-10T18:30:00.000Z');
});

test('matching captured paid evidence produces only decision data, not an entitlement or persisted order', () => {
  const value = matchContext(), result = matchVerifiedPaymentEvent(value);
  assert.equal(result.decision, 'matched_payment_evidence');
  assert.equal(result.authorizationCreated, false); assert.equal(result.requiresAtomicPersistence, true);
  assert.equal(result.windowState, 'not_open'); assert.equal(result.paymentId, value.event.paymentId);
  assert.deepEqual(result.accessWindow, {opensAt: value.order.accessOpensAt, expiresAt: value.order.accessExpiresAt});
  assert.ok(!own(result, 'grantId')); assert.equal(value.order.status, 'pending_payment');
  assert.deepEqual(matchVerifiedPaymentEvent(value), result, 'A repeated pure validation is not database idempotency');
});
function own(value, field) { return Object.prototype.hasOwnProperty.call(value, field); }

test('payment identity, amount, currency, mode, sitting and track must match the saved order exactly', () => {
  for (const extra of [{orderId: '44444444-4444-4444-8444-444444444444'}, {paymentId: 'another-captured-payment'}, {userId: otherUser}, {amountMinor: 1}, {amountMinor: '35900'},
    {currency: 'USD'}, {currency: 'hkd'}, {mode: 'subscription'}, {examSittingId: 'another-sitting'}, {examTrack: 'sqe'}]) {
    const value = matchContext(); Object.assign(value.event, extra);
    assert.throws(() => matchVerifiedPaymentEvent(value), error('payment_event_mismatch'));
  }
  for (const paymentStatus of ['unpaid', 'pending', 'failed', 'cancelled', 'refunded']) {
    const value = matchContext(); value.event.paymentStatus = paymentStatus;
    assert.throws(() => matchVerifiedPaymentEvent(value), error('payment_not_paid'));
  }
});

test('test/live environments cannot cross even for an otherwise matching paid event', () => {
  for (const field of ['event', 'order']) {
    const value = matchContext(); value[field].environment = 'live';
    assert.throws(() => matchVerifiedPaymentEvent(value), error('payment_environment'));
  }
  assert.throws(() => createPendingOrder({...context(), paymentEnvironment: 'disabled'}), error('payment_environment'));
});

test('corrupt order amount, plan, window or state cannot be repaired by matching event metadata', () => {
  for (const extra of [{amountMinor: 100}, {planId: 'customer-plan'}, {accessExpiresAt: '2036-01-01T00:00:00.000Z'}, {status: 'paid'}, {mode: 'subscription'}]) {
    const value = matchContext(); Object.assign(value.order, extra);
    assert.throws(() => matchVerifiedPaymentEvent(value), error('payment_order_mismatch'));
  }
});

test('current official schedule changes or cancellation stop processing without deciding refund or extension policy', () => {
  const value = matchContext(); value.verifiedSittings[0].startsAt = '2035-12-16T06:30:00Z'; value.verifiedSittings[0].endsAt = '2035-12-16T09:30:00Z';
  assert.throws(() => matchVerifiedPaymentEvent(value), error('payment_sitting_changed'));
  const cancelled = matchContext(); cancelled.verifiedSittings[0].status = 'cancelled';
  assert.throws(() => matchVerifiedPaymentEvent(cancelled), error('payment_unavailable_sitting'));
});

test('invalid event time cannot predate its order or claim a future capture; expired-window evidence creates no access', () => {
  for (const paidAt of ['2035-10-04T03:59:59Z', '2035-10-04T04:03:00Z']) {
    const value = matchContext(); value.event.paidAt = paidAt;
    assert.throws(() => matchVerifiedPaymentEvent(value), error('payment_invalid_time'));
  }
  const delayed = matchContext(); delayed.now = '2035-12-26T00:00:00Z';
  const result = matchVerifiedPaymentEvent(delayed);
  assert.equal(result.windowState, 'expired'); assert.equal(result.authorizationCreated, false);
});

test('provider event/payment IDs are mandatory and client signature flags are not accepted as evidence', () => {
  for (const extra of [{eventId: ''}, {paymentId: ''}, {signatureVerified: true}, {paid: true}]) {
    const value = matchContext(); Object.assign(value.event, extra);
    assert.throws(() => matchVerifiedPaymentEvent(value), error('payment_invalid'));
  }
  const missing = matchContext(); delete missing.expectedPaymentId;
  assert.throws(() => matchVerifiedPaymentEvent(missing), error('payment_invalid'));
});
