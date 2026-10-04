import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {auditQuestionContent, parseRightsCsv, questionFingerprint} from '../scripts/audit-question-content.mjs';

const id = 'PX-0000000000000001';
const question = (overrides = {}) => ({
  id, version: 1, status: 'ready', part: 2, type: '獨立題', free: true,
  examTracks: ['eaqe', 'sqe'], stem: '測試資料：下列哪個選項適用？',
  options: ['選項甲', '選項乙', '選項丙', '選項丁', '選項戊'], answer: 0,
  concept: '測試概念', explanation: '正確答案是第一項。',
  optionNotes: ['正確：符合題目條件。', '不正確：欠缺條件。', '不正確：混淆範圍。', '不正確：程序不符。', '不正確：時間不符。'],
  ...overrides
});
const rights = (overrides = {}) => ({
  question_id: id, version: '1', approved_for_publication: '是',
  source_type: '自擬', source_reference: 'https://example.gov.hk/source',
  rights_basis: '測試記錄；不是實際使用權核准', answer_source: 'https://example.gov.hk/rule',
  verified_date: '2026-10-04', reviewer: '測試覆核人', ...overrides
});

test('CSV preserves quoted commas, quotes, CRLF and embedded newlines', () => {
  const rows = parseRightsCsv('question_id,approved_for_publication,decision_notes\r\nPX-0000000000000001,否,"第一行,第二欄\n引號""內容"""\r\n');
  assert.deepEqual(rows, [{question_id: id, approved_for_publication: '否', decision_notes: '第一行,第二欄\n引號"內容"'}]);
  for (const invalid of ['question_id,approved_for_publication\na,是,多餘', 'question_id,question_id,approved_for_publication\na,b,是', 'question_id,approved_for_publication\na,"未完']) {
    assert.throws(() => parseRightsCsv(invalid));
  }
});

test('complete structure cannot imply permission to publish', () => {
  const result = auditQuestionContent([question()]);
  assert.equal(result.structuralPassed, true);
  assert.equal(result.contradictions.length, 0);
  assert.equal(result.rightsApprovedCount, 0);
  assert.equal(result.publicationBlocked, true);
  assert.deepEqual(result.publicationEligibleIds, []);
});

test('structural omissions and duplicate normalised options block publication', () => {
  const result = auditQuestionContent([question({options: ['甲', '乙', '丙', ' 丁 ', '丁'], concept: ''})], [rights()]);
  assert.equal(result.structuralPassed, false);
  assert.ok(result.structuralIssues.some(issue => issue.code === 'duplicate_options'));
  assert.ok(result.structuralIssues.some(issue => issue.code === 'missing_concept'));
  assert.equal(result.publicationEligibleIds.length, 0);
});

test('duplicate IDs and repeated stems are detectable', () => {
  const result = auditQuestionContent([question(), question()]);
  assert.ok(result.structuralIssues.some(issue => issue.code === 'duplicate_id'));
  assert.ok(result.structuralIssues.some(issue => issue.code === 'duplicate_stem'));
});

test('answer key conflicts are detected in letter, ordinal and option notes', () => {
  for (const explanation of ['正確答案是第一項。', '答案：A。']) {
    const result = auditQuestionContent([question({answer: 2, explanation})]);
    assert.ok(result.contradictions.some(issue => issue.code === 'answer_explanation_conflict'));
    assert.ok(result.contradictions.some(issue => issue.code === 'answer_option_notes_conflict'));
  }
  const multiple = auditQuestionContent([question({optionNotes: ['正確：符合。', '正確：亦符合。', '不正確：丙。', '不正確：丁。', '不正確：戊。']})]);
  assert.ok(multiple.contradictions.some(issue => issue.code === 'answer_option_notes_conflict'));
});

test('generic content is a review signal, not a fabricated factual error', () => {
  const result = auditQuestionContent([question({
    stem: '交易雙方就測試條件需要判斷。',
    explanation: '正確答案是第一項。其餘選項均忽略正式文件、適用條件或主管機關權限。'
  })]);
  assert.equal(result.structuralPassed, true);
  assert.equal(result.contradictions.length, 0);
  assert.equal(result.qualityFlagCounts.generic_context_requires_review, 1);
  assert.equal(result.qualityFlagCounts.generic_explanation_requires_review, 1);
});

test('permission requires current version, all evidence fields and a real date', () => {
  assert.deepEqual(auditQuestionContent([question()], [rights()]).publicationEligibleIds, [id]);
  for (const invalid of [{version: '2'}, {reviewer: ''}, {rights_basis: ''}, {answer_source: ''}, {verified_date: '2026-02-31'}, {approved_for_publication: '否（待審）'}]) {
    assert.equal(auditQuestionContent([question()], [rights(invalid)]).publicationEligibleIds.length, 0);
  }
  assert.equal(auditQuestionContent([question({status: 'draft'})], [rights()]).publicationEligibleIds.length, 0);
});

test('changing a blocked question cannot silently clear its manual review', () => {
  const original = question();
  const register = {blockers: [{id, version: 1, fingerprint: questionFingerprint(original), status: 'open', reasonCode: 'missing_case_facts'}]};
  const unchanged = auditQuestionContent([original], [rights()], register);
  assert.equal(unchanged.publicationEligibleIds.length, 0);
  assert.equal(unchanged.changedReviewIds.length, 0);
  const revised = auditQuestionContent([question({version: 2, stem: '補齊案情後的測試題。'})], [rights({version: '2'})], register);
  assert.deepEqual(revised.changedReviewIds, [id]);
  assert.equal(revised.activeBlockers.length, 1);
  assert.equal(revised.publicationEligibleIds.length, 0);
});

test('machine report omits stems and private source references', () => {
  const sentinel = '不應流出的私人資料測試值';
  const result = auditQuestionContent([question({stem: sentinel})], [rights({source_reference: sentinel})]);
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test('current question bank and blocker register remain consistent', async () => {
  const [questions, rows, register] = await Promise.all([
    readFile(new URL('../dist/questions.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../docs/content-source-rights-audit.csv', import.meta.url), 'utf8').then(parseRightsCsv),
    readFile(new URL('../docs/question-review-blockers.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  const result = auditQuestionContent(questions, rows, register);
  assert.equal(result.structuralPassed, true);
  assert.equal(result.changedReviewIds.length, 0);
  assert.equal(new Set(register.blockers.map(blocker => blocker.id)).size, register.blockers.length);
  assert.ok(result.activeBlockers.length > 0);
  assert.equal(result.rightsApprovedCount, 0);
  assert.equal(result.publicationEligibleIds.length, 0);
  assert.ok(result.contradictions.some(issue => issue.id === 'PX-82EF70B7B0D24EAC' && issue.code === 'answer_explanation_conflict'));
});
