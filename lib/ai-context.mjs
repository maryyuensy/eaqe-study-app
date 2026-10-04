// Preparation only: no model client, provider selection, network call or route.
// Trusted authorization/records must be freshly read on the server. Browser
// fields, localStorage and an AI response are never authorization evidence.
export class AiContextError extends Error {
  constructor(code) { super(code); this.name = 'AiContextError'; this.code = code; }
}
const fail = code => { throw new AiContextError(code); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const questionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
function record(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => own(d, 'get') || own(d, 'set'))) fail(code);
  return value;
}
function text(value, max, code) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(code);
  return value;
}
function timestamp(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) fail(code);
  const at = new Date(value), canonical = value.includes('.') ? value : value.replace('Z', '.000Z');
  if (!Number.isFinite(at.getTime()) || at.toISOString() !== canonical) fail(code);
  return at.getTime();
}
function date(value, code) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(code);
  const at = new Date(value + 'T00:00:00Z');
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 10) !== value) fail(code);
  return value;
}
function sourceUrl(value) {
  text(value, 1000, 'ai_unapproved_source');
  let url; try { url = new URL(value); } catch { fail('ai_unapproved_source'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) fail('ai_unapproved_source');
  return url.href;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// A finite user input contract, not a semantic scope/injection detector.
// message is optional for automatic explanation and required by a future
// follow-up route. Its mere presence does not authorize an AI call.
export function validateAiRequest(input) {
  record(input, 'ai_invalid_request');
  const allowed = ['attemptId', 'questionId', 'questionVersion', 'message'];
  if (Object.keys(input).some(key => !allowed.includes(key)) ||
      typeof input.attemptId !== 'string' || !uuid.test(input.attemptId) ||
      typeof input.questionId !== 'string' || !questionId.test(input.questionId) ||
      !Number.isSafeInteger(input.questionVersion) || input.questionVersion < 1) fail('ai_invalid_request');
  const result = {attemptId: input.attemptId, questionId: input.questionId, questionVersion: input.questionVersion};
  if (own(input, 'message')) result.message = text(input.message, 2000, 'ai_invalid_request').trim();
  return freeze(result);
}

// authorization and approvedSources are server-owned evidence, not request
// properties. This projection cannot itself authenticate a caller, query RLS,
// establish commercial rights or verify that a URL supports a legal claim.
export function projectAiContext({request, authenticatedUserId, authorization, attempt, question, approvedSources, now}) {
  const input = validateAiRequest(request), at = timestamp(now, 'ai_invalid_clock');
  record(authorization, 'ai_unauthorized'); record(attempt, 'ai_unsubmitted'); record(question, 'ai_unapproved_question');
  if (typeof authenticatedUserId !== 'string' || !uuid.test(authenticatedUserId) || authorization.allowed !== true ||
      authorization.userId !== authenticatedUserId || authorization.questionId !== input.questionId ||
      authorization.questionVersion !== input.questionVersion || !['eaqe', 'sqe'].includes(authorization.track)) fail('ai_unauthorized');
  if (attempt.user_id !== authenticatedUserId) fail('ai_unauthorized');
  if (attempt.id !== input.attemptId || attempt.question_id !== input.questionId ||
      attempt.question_version !== input.questionVersion || typeof attempt.session_id !== 'string' || !uuid.test(attempt.session_id) ||
      typeof attempt.correct !== 'boolean' || timestamp(attempt.accepted_at, 'ai_unsubmitted') > at) fail('ai_unsubmitted');
  if (question.question_id !== input.questionId || question.version !== input.questionVersion ||
      question.published !== true || question.rights_status !== 'approved' || question.review_status !== 'approved' ||
      timestamp(question.verified_at, 'ai_unapproved_question') > at || !Array.isArray(question.tracks) ||
      !question.tracks.includes(authorization.track) || !Number.isInteger(question.part) || question.part < 1 || question.part > 8) fail('ai_unapproved_question');
  if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 5) fail('ai_incomplete_question');
  const seen = new Set(), options = question.options.map(value => {
    record(value, 'ai_incomplete_question'); const id = text(value.id, 100, 'ai_incomplete_question');
    if (seen.has(id)) fail('ai_incomplete_question'); seen.add(id);
    return {id, text: text(value.text, 10000, 'ai_incomplete_question')};
  });
  if (!seen.has(question.answer_option_id) || !seen.has(attempt.option_id) ||
      attempt.correct !== (attempt.option_id === question.answer_option_id)) fail('ai_incomplete_question');
  record(question.explanation, 'ai_incomplete_question'); record(question.explanation.options, 'ai_incomplete_question');
  const explanation = {core: text(question.explanation.core, 10000, 'ai_incomplete_question'),
    apply: text(question.explanation.apply, 10000, 'ai_incomplete_question'),
    options: Object.fromEntries(options.map(option => [option.id, text(question.explanation.options[option.id], 10000, 'ai_incomplete_question')])),
    memory: text(question.explanation.memory, 10000, 'ai_incomplete_question')};
  if (!Array.isArray(question.sources) || !question.sources.length || question.sources.length > 8 ||
      !Array.isArray(approvedSources) || !approvedSources.length) fail('ai_unapproved_source');
  const today = new Date(at + 8 * 3600000).toISOString().slice(0, 10), sources = question.sources.map(value => {
    record(value, 'ai_unapproved_source'); const url = sourceUrl(value.url), verifiedAt = date(value.verifiedAt, 'ai_unapproved_source');
    if (verifiedAt > today || !approvedSources.some(approval => {
      record(approval, 'ai_unapproved_source');
      return approval.approved === true && approval.url === url && approval.verifiedAt === verifiedAt;
    })) fail('ai_unapproved_source');
    return {url, verifiedAt};
  });
  const projectedQuestion = {id: question.question_id, version: question.version, part: question.part,
    concept: text(question.concept, 200, 'ai_incomplete_question'), stem: text(question.stem, 10000, 'ai_incomplete_question'), options};
  if (question.case_group_id != null || question.case_stem != null) {
    text(question.case_group_id, 100, 'ai_incomplete_question');
    projectedQuestion.caseStem = text(question.case_stem, 10000, 'ai_incomplete_question');
  }
  const result = {schemaVersion: 1, purpose: 'eaqe-sqe-after-answer', track: authorization.track,
    question: projectedQuestion, submission: {optionId: attempt.option_id, correct: attempt.correct},
    fixedAnswer: {optionId: question.answer_option_id, explanation}, sources};
  if (own(input, 'message')) result.learnerQuestion = input.message;
  // Resource ceiling only; not a provider token quota, cost guarantee or policy.
  if (JSON.stringify(result).length > 60000) fail('ai_context_too_large');
  return freeze(result);
}
