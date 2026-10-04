import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdtemp, mkdir, rm, access, copyFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {reviewPolicy} from '../scripts/export-review-policy.mjs';
import {prepareQuestions, publicationFingerprint} from '../scripts/prepare-question-import.mjs';
import {questionFingerprint} from '../scripts/audit-question-content.mjs';

const q = {id: 'PX-1111111111111111', version: 1, status: 'ready', part: 1, type: 'independent', stem: 'Synthetic original question',
  options: ['one', 'two', 'three', 'four', 'five'], answer: 0, concept: 'Synthetic concept', explanation: 'Synthetic application',
  optionNotes: ['正確。Synthetic rationale', '錯誤。Reason two', '錯誤。Reason three', '錯誤。Reason four', '錯誤。Reason five'], examTracks: ['eaqe'], free: true};
const row = {question_id: q.id, version: '1', approved_for_publication: '是', source_type: '自擬', source_reference: 'synthetic',
  rights_basis: 'synthetic original only', answer_source: 'https://example.invalid/official', verified_date: '2026-10-04', reviewer: 'synthetic'};
const approval = {id: q.id, version: 1, fingerprint: questionFingerprint(q), publicationFingerprint: publicationFingerprint(q), answerApproved: true, teachingApproved: true,
  rightsApproved: true, reviewer: 'synthetic', reviewedAt: '2026-10-04'};
const manifest = item => ({schemaVersion: 1, approvals: [item]});
const blockers = {schemaVersion: 1, reviewDate: '2026-10-04', blockers: []};

test('unreviewed or changed content cannot become approved by renaming or reordering', () => {
  assert.throws(() => prepareQuestions([q], [row], blockers, {schemaVersion: 1, approvals: []}));
  assert.throws(() => prepareQuestions([q], [{...row, approved_for_publication: '否'}], blockers, manifest(approval)));
  assert.throws(() => prepareQuestions([{...q, stem: 'Renamed person'}], [row], blockers, manifest(approval)));
  assert.throws(() => prepareQuestions([q], [row], blockers, manifest({...approval, teachingApproved: false})));
  assert.throws(() => prepareQuestions([q], [row], {...blockers, blockers: [{id: q.id, version: 1, status: 'open', reasonCode: 'known-wrong'}]}, manifest(approval)));
});

test('server import approval also binds paid/free scope, examination mapping and question type', () => {
  const paid = {...q, free: false}, approvedPaid = {...approval, publicationFingerprint: publicationFingerprint(paid)};
  const promoted = {...paid, free: true};
  assert.equal(questionFingerprint(paid), questionFingerprint(promoted));
  assert.throws(() => prepareQuestions([promoted], [row], blockers, manifest(approvedPaid)), /Review incomplete/);
  for (const changed of [{...q, part: 2}, {...q, examTracks: ['sqe']}, {...q, type: '個案題'}]) {
    assert.throws(() => prepareQuestions([changed], [row], blockers, manifest(approval)), /Review incomplete/);
  }
  assert.throws(() => prepareQuestions([q], [row], blockers, manifest({...approval, publicationFingerprint: undefined})), /Review incomplete/);
  const caseQuestion = {...q, type: '個案題', caseStem: 'Synthetic shared context'};
  assert.throws(() => prepareQuestions([caseQuestion], [row], blockers, manifest({...approval, publicationFingerprint: publicationFingerprint(caseQuestion)})), /Unsupported shared case context/);
});

test('reviewed synthetic import carries stable option IDs and full explanation outside public dist', () => {
  const [result] = prepareQuestions([q], [row], blockers, manifest(approval));
  assert.equal(result.answer_option_id, 'opt_1');
  assert.deepEqual(Object.keys(result.explanation.options), result.options.map(option => option.id));
  assert.equal(result.rights_status, 'approved');
  assert.equal(result.review_status, 'approved');
});

test('CLI removes a stale private import artifact when approval is withdrawn without writing a database', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'eaqe-import-withdrawal-')));
  t.after(() => rm(root, {recursive: true, force: true}));
  for (const directory of ['scripts', 'dist', 'docs']) await mkdir(join(root, directory));
  for (const name of ['prepare-question-import.mjs', 'audit-question-content.mjs']) await copyFile(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
  await writeFile(join(root, 'dist/questions.json'), JSON.stringify([q]));
  const csv = [Object.keys(row), Object.values(row)].map(fields => fields.map(value => '"' + String(value).replaceAll('"', '""') + '"').join(',')).join('\n');
  await writeFile(join(root, 'docs/content-source-rights-audit.csv'), csv);
  await writeFile(join(root, 'docs/question-review-blockers.json'), JSON.stringify(blockers));
  const approvalsPath = join(root, 'docs/content-release-approvals.json');
  await writeFile(approvalsPath, JSON.stringify(manifest(approval)));
  const cli = promisify(execFile), script = join(root, 'scripts/prepare-question-import.mjs');
  await cli(process.execPath, [script]);
  const output = join(root, 'release/approved-question-import.json');
  assert.equal(JSON.parse(await readFile(output, 'utf8')).length, 1);
  await writeFile(approvalsPath, JSON.stringify({schemaVersion: 1, approvals: []}));
  await assert.rejects(cli(process.execPath, [script]), error => error.code === 1 && error.stderr.includes('BLOCKED'));
  await assert.rejects(access(output), {code: 'ENOENT'});
});

test('known blockers remain blocked across question edits until explicitly resolved', () => {
  const registry = {...blockers, blockers: [{id: q.id, version: 1, status: 'open'}]};
  assert.deepEqual(reviewPolicy([{...q, version: 2}], registry).blockedQuestionIds, [q.id]);
  assert.throws(() => reviewPolicy([q], {...registry, blockers: [{id: 'missing', status: 'open'}]}));
});

test('public review policy is reproducible and contains no questions, answers or private source', async () => {
  const [questions, register, policy] = await Promise.all([
    readFile(new URL('../dist/questions.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../docs/question-review-blockers.json', import.meta.url), 'utf8').then(JSON.parse),
    readFile(new URL('../dist/content-review.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  assert.deepEqual(policy, reviewPolicy(questions, register));
  assert.equal(policy.blockedQuestionIds.length, 17);
  assert.deepEqual(Object.keys(policy).sort(), ['blockedQuestionIds', 'commercialApprovedCount', 'reviewDate', 'schemaVersion']);
});
