import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink, access} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildCommercial, commercialAssets, commercialQuestionFingerprint} from '../scripts/build-commercial.mjs';
import {questionFingerprint, parseRightsCsv} from '../scripts/audit-question-content.mjs';

const q = (digit, free) => ({
  id: `PX-${digit.repeat(16)}`, version: 1, status: 'ready', part: 1, type: '獨立題',
  stem: `Synthetic original question scenario ${digit}, not a published examination item.`,
  options: ['Synthetic one', 'Synthetic two', 'Synthetic three', 'Synthetic four', 'Synthetic five'],
  answer: 0, concept: `Synthetic concept ${digit}`, explanation: `Synthetic applied explanation ${digit}.`,
  optionNotes: ['正確。Synthetic rationale one.', '錯誤。Synthetic reason two.', '錯誤。Synthetic reason three.', '錯誤。Synthetic reason four.', '錯誤。Synthetic reason five.'],
  examTracks: ['eaqe', 'sqe'], free,
  privateSource: 'PRIVATE SOURCE MUST NEVER BE PUBLIC', userHistory: [{email: 'PRIVATE USER RECORD'}]
});
const rights = question => ({
  question_id: question.id, version: '1', approved_for_publication: '是', source_type: '自擬',
  source_reference: 'PRIVATE RIGHTS REFERENCE', rights_basis: 'Synthetic original only.',
  answer_source: 'https://example.invalid/official-synthetic', verified_date: '2026-10-04', reviewer: 'PRIVATE RIGHTS REVIEWER'
});
const approval = question => ({id: question.id, version: question.version, fingerprint: questionFingerprint(question),
  publicationFingerprint: commercialQuestionFingerprint(question),
  answerApproved: true, teachingApproved: true, rightsApproved: true, reviewer: 'PRIVATE REVIEWER', reviewedAt: '2026-10-04'});
function inputs(questions = [q('1', true), q('2', false), q('3', true)], approve = [0, 1]) {
  return {questions, rightsRows: questions.map(rights), blockers: {schemaVersion: 1, reviewDate: '2026-10-04', blockers: []},
    approvals: {schemaVersion: 1, approvals: approve.map(index => approval(questions[index]))}};
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'eaqe-commercial-build-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  await mkdir(join(root, 'dist'));
  for (const name of commercialAssets) await writeFile(join(root, 'dist', name), name === 'index.html' ? '<!doctype html><html><body><main id="main"></main></body></html>' : `/* Synthetic static asset: ${name} */`);
  return root;
}
async function outputBank(root) { return JSON.parse(await readFile(join(root, 'release/site/questions.json'), 'utf8')); }
async function absent(path) { await assert.rejects(access(path), {code: 'ENOENT'}); }

test('only reviewed free questions enter the public bank; private metadata and paid/unapproved text are absent', async t => {
  const root = await fixture(t), data = inputs();
  await writeFile(join(root, 'dist/questions.json'), JSON.stringify(data.questions));
  await writeFile(join(root, 'dist/content-review.json'), JSON.stringify({blockedQuestionIds: [data.questions[2].id], PRIVATE: 'SOURCE'}));
  const result = await buildCommercial({rootDirectory: root, inputs: data});
  assert.equal(result.status, 'approved_free_ready');
  assert.equal(result.publicQuestionCount, 1);
  const [only] = await outputBank(root);
  assert.deepEqual(only, Object.fromEntries(Object.entries(data.questions[0]).filter(([key]) => !['privateSource', 'userHistory'].includes(key))));
  const files = await readdir(join(root, 'release/site'));
  assert.deepEqual(files.sort(), [...commercialAssets, 'questions.json', 'content-review.json', 'build-status.json'].sort());
  const output = (await Promise.all(files.map(name => readFile(join(root, 'release/site', name), 'utf8')))).join('\n');
  for (const forbidden of ['PRIVATE', data.questions[1].id, data.questions[1].stem, data.questions[2].id, data.questions[2].stem, 'example.invalid']) assert.ok(!output.includes(forbidden), forbidden);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'release/site/content-review.json'), 'utf8')),
    {blockedQuestionIds: [], reviewDate: '2026-10-04', commercialApprovedCount: 1});
});

test('zero approvals fail closed, remove a stale generated site, and do not fallback to the source bank', async t => {
  const root = await fixture(t), data = inputs(undefined, []);
  await mkdir(join(root, 'release/site'), {recursive: true});
  await writeFile(join(root, 'release/site/questions.json'), 'PRIVATE OLD BANK');
  await assert.rejects(buildCommercial({rootDirectory: root, inputs: data}), /No approved free content/);
  await absent(join(root, 'release/site'));
});

test('explicit empty preview writes an empty bank and visible status; it never exposes the input bank', async t => {
  const root = await fixture(t), data = inputs(undefined, []);
  const result = await buildCommercial({rootDirectory: root, inputs: data, allowEmptyPreview: true});
  assert.equal(result.status, 'empty_preview_content_pending');
  assert.equal(result.preview, true);
  assert.deepEqual(await outputBank(root), []);
  const html = await readFile(join(root, 'release/site/index.html'), 'utf8');
  assert.match(html, /data-commercial-preview="empty"/);
  assert.match(html, /內容未核准預覽：目前不提供公開題目/);
  assert.ok(html.indexOf('data-commercial-preview') < html.indexOf('<main'));
  assert.equal(JSON.parse(await readFile(join(root, 'release/site/content-review.json'), 'utf8')).commercialApprovedCount, 0);
});

test('stale fingerprint, rights refusal, unresolved review or incomplete approval fail even in preview mode', async t => {
  const root = await fixture(t);
  const variants = [
    data => { data.questions[0].stem += ' changed after review'; },
    data => { data.rightsRows[0].approved_for_publication = '否'; },
    data => { data.blockers.blockers.push({id: data.questions[0].id, version: 1, status: 'pending'}); },
    data => { data.approvals.approvals[0].teachingApproved = false; },
    data => { data.questions[0].optionNotes[0] = '錯誤。Conflicts with answer.'; data.approvals.approvals[0] = approval(data.questions[0]); }
  ];
  for (const mutate of variants) {
    const data = inputs(); mutate(data);
    await assert.rejects(buildCommercial({rootDirectory: root, inputs: data, allowEmptyPreview: true}), /Review incomplete/);
    await absent(join(root, 'release/site'));
  }
});

test('paid-only approvals cannot produce a normal site and remain empty in explicit preview', async t => {
  const root = await fixture(t), data = inputs(undefined, [1]);
  await assert.rejects(buildCommercial({rootDirectory: root, inputs: data}), /No approved free content/);
  await buildCommercial({rootDirectory: root, inputs: data, allowEmptyPreview: true});
  assert.deepEqual(await outputBank(root), []);
});

test('an approved case question cannot silently lose its common stem during static projection', async t => {
  const root = await fixture(t), data = inputs();
  data.questions[0].type = '個案題'; data.questions[0].caseStem = 'Synthetic shared case context.';
  data.approvals.approvals[0] = approval(data.questions[0]);
  await assert.rejects(buildCommercial({rootDirectory: root, inputs: data, allowEmptyPreview: true}), /Unsupported shared case context/);
  await absent(join(root, 'release/site'));
});

test('public scope approval binds free status, tracks, syllabus, type and version', async t => {
  const root = await fixture(t);
  const variants = [
    data => { data.questions[1].free = true; },
    data => { data.questions[0].examTracks = ['sqe']; },
    data => { data.questions[0].part = 2; },
    data => { data.questions[0].type = '個案題'; },
    data => { delete data.approvals.approvals[0].publicationFingerprint; }
  ];
  for (const mutate of variants) {
    const data = inputs(); mutate(data);
    await assert.rejects(buildCommercial({rootDirectory: root, inputs: data, allowEmptyPreview: true}), /Review incomplete/);
    await absent(join(root, 'release/site'));
  }
});

test('unlisted backups, source maps, private import files and old banks are never copied', async t => {
  const root = await fixture(t);
  for (const name of ['old-questions.json', 'app.js.map', 'questions.backup.json', '.env', 'approved-question-import.json']) await writeFile(join(root, 'dist', name), 'PRIVATE');
  await mkdir(join(root, 'dist/old')); await writeFile(join(root, 'dist/old/questions.json'), 'PRIVATE');
  await buildCommercial({rootDirectory: root, inputs: inputs()});
  for (const name of ['old-questions.json', 'app.js.map', 'questions.backup.json', '.env', 'approved-question-import.json', 'old']) await absent(join(root, 'release/site', name));
});

test('source map references, secret tokens, embedded private questions and asset symlinks block output', async t => {
  const variants = [
    '// sourceMappingURL=app.js.map',
    'const token="sk_live_SyntheticForbidden";',
    'const token="sk_test_SyntheticForbidden";',
    'const token="sk-proj-SyntheticForbidden";',
    'const token="whsec_SyntheticForbidden";',
    'const token="sb_secret_SyntheticForbidden";',
    `const token="${Buffer.from(JSON.stringify({typ: 'JWT', alg: 'HS256'})).toString('base64url')}.${Buffer.from(JSON.stringify({role: 'service_role', placeholder: 'synthetic-only'})).toString('base64url')}.${'A'.repeat(43)}";`,
    `const paid=${JSON.stringify(q('2', false).stem)};`,
    `const privateId=${JSON.stringify(q('3', true).id)};`
  ];
  for (const value of variants) {
    const root = await fixture(t);
    await writeFile(join(root, 'dist/app.js'), value);
    await assert.rejects(buildCommercial({rootDirectory: root, inputs: inputs()}), /Private/);
    await absent(join(root, 'release/site'));
  }
  const root = await fixture(t);
  await rm(join(root, 'dist/app.js')); await symlink('core.js', join(root, 'dist/app.js'));
  await assert.rejects(buildCommercial({rootDirectory: root, inputs: inputs()}), /Unsafe static asset/);
  await absent(join(root, 'release/site'));
});

test('missing ledger files never trigger an automatic preview or fallback', async t => {
  const root = await fixture(t);
  await writeFile(join(root, 'dist/questions.json'), JSON.stringify(inputs().questions));
  await assert.rejects(buildCommercial({rootDirectory: root, allowEmptyPreview: true}), {code: 'ENOENT'});
  await absent(join(root, 'release/site'));
});

test('commercial entry only accepts external bootstrap and the script CSP forbids inline execution', async t => {
  const root = await fixture(t), entry = join(root, 'dist/index.html');
  await writeFile(entry, '<html><body><script src="./bootstrap.js" type="module"></script></body></html>');
  await buildCommercial({rootDirectory: root, inputs: inputs()});
  for (const content of ['<html><body><script>alert(1)</script></body></html>', '<html><body onclick="alert(1)"></body></html>', '<html><body><script src="https://example.invalid/private-bank.js"></script></body></html>']) {
    await writeFile(entry, content);
    await assert.rejects(buildCommercial({rootDirectory: root, inputs: inputs()}));
    await absent(join(root, 'release/site'));
  }
  const config = JSON.parse(await readFile(new URL('../vercel.commercial.json', import.meta.url), 'utf8'));
  assert.match(config.headers[0].headers.find(header => header.key === 'Content-Security-Policy').value, /script-src 'self';/);
});

test('real library obeys its approval ledger and every deployment config requires the commercial gate', async t => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const [questionText, csv, blockerText, approvalText, configText, prototypeText] = await Promise.all([
    readFile(join(project, 'dist/questions.json'), 'utf8'), readFile(join(project, 'docs/content-source-rights-audit.csv'), 'utf8'),
    readFile(join(project, 'docs/question-review-blockers.json'), 'utf8'), readFile(join(project, 'docs/content-release-approvals.json'), 'utf8'),
    readFile(join(project, 'vercel.commercial.json'), 'utf8'), readFile(join(project, 'vercel.json'), 'utf8')
  ]);
  const real = {questions: JSON.parse(questionText), rightsRows: parseRightsCsv(csv), blockers: JSON.parse(blockerText), approvals: JSON.parse(approvalText)};
  const root = await fixture(t);
  if (!real.approvals.approvals.length) {
    await assert.rejects(buildCommercial({rootDirectory: root, inputs: real}), /No approved free content/);
    await absent(join(root, 'release/site'));
  } else {
    // Reviewed candidates still have to pass the same gate; never assume an
    // approval file alone makes a paid question safe to include publicly.
    const approvedFreeIds = new Set(real.approvals.approvals.filter(item => real.questions.find(question => question.id === item.id)?.free).map(item => item.id));
    await buildCommercial({rootDirectory: root, inputs: real, allowEmptyPreview: true});
    for (const question of await outputBank(root)) assert.ok(question.free && approvedFreeIds.has(question.id));
  }
  const config = JSON.parse(configText), prototype = JSON.parse(prototypeText);
  assert.equal(config.outputDirectory, 'release/site');
  assert.equal(config.buildCommand, 'node scripts/build-commercial.mjs');
  assert.equal(prototype.outputDirectory, 'release/site');
  assert.equal(prototype.buildCommand, 'node scripts/build-commercial.mjs');
});
