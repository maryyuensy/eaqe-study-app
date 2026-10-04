import {readFile, writeFile, mkdir, rm} from 'node:fs/promises';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {dirname, join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {auditQuestionContent, parseRightsCsv, questionFingerprint} from './audit-question-content.mjs';

// Approval of question text alone cannot authorize later changes in free scope
// or examination classification. This fingerprint binds the whole projection.
export function publicationFingerprint(question) {
  return createHash('sha256').update(JSON.stringify({
    id: question.id, version: question.version, status: question.status, type: question.type,
    part: question.part, examTracks: question.examTracks, free: question.free,
    contentFingerprint: questionFingerprint(question)
  })).digest('hex');
}

// A reviewed import is separate from the public static prototype. No network or automatic database writes.
export function prepareQuestions(questions, rightsRows, blockers, approvals) {
  if (approvals?.schemaVersion !== 1 || !Array.isArray(approvals.approvals) || !approvals.approvals.length) throw Error('No reviewed content');
  const audit = auditQuestionContent(questions, rightsRows, blockers);
  if (!audit.structuralPassed) throw Error('Invalid content');
  const eligible = new Set(audit.publicationEligibleIds), seen = new Set();
  return approvals.approvals.map(approval => {
    const q = questions.find(value => value.id === approval.id);
    if (!q || seen.has(q.id) || !eligible.has(q.id) || approval.version !== q.version || approval.fingerprint !== questionFingerprint(q) ||
        approval.publicationFingerprint !== publicationFingerprint(q) ||
        approval.answerApproved !== true || approval.teachingApproved !== true || approval.rightsApproved !== true ||
        typeof approval.reviewer !== 'string' || !approval.reviewer.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(approval.reviewedAt || '')) throw Error('Review incomplete');
    seen.add(q.id);
    // Shared case context is not yet mapped by this importer. Reject it rather
    // than manufacture incomplete independent questions from a case group.
    if (!['獨立題', 'independent'].includes(q.type)) throw Error('Unsupported shared case context');
    const rights = rightsRows.find(value => value.question_id === q.id);
    const options = q.options.map((text, index) => ({id: `opt_${index + 1}`, text}));
    return {question_id: q.id, version: q.version, stem: q.stem, options,
      answer_option_id: options[q.answer].id, concept: q.concept,
      explanation: {core: q.concept, apply: q.explanation,
        options: Object.fromEntries(options.map((option, index) => [option.id, q.optionNotes[index]])),
        memory: q.concept},
      part: q.part, tracks: q.examTracks, is_free: q.free,
      rights_status: 'approved', review_status: 'approved', published: true,
      verified_at: rights.verified_date + 'T00:00:00Z', sources: [{url: rights.answer_source, verifiedAt: rights.verified_date}]};
  });
}

export async function prepareImport({rootDirectory = dirname(dirname(fileURLToPath(import.meta.url)))} = {}) {
  const root = resolve(rootDirectory), output = join(root, 'release/approved-question-import.json');
  try {
    const [questions, csv, blockers, approvals] = await Promise.all([
      readFile(join(root, 'dist/questions.json'), 'utf8').then(JSON.parse),
      readFile(join(root, 'docs/content-source-rights-audit.csv'), 'utf8'),
      readFile(join(root, 'docs/question-review-blockers.json'), 'utf8').then(JSON.parse),
      readFile(join(root, 'docs/content-release-approvals.json'), 'utf8').then(JSON.parse)
    ]);
    const rows = prepareQuestions(questions, parseRightsCsv(csv), blockers, approvals);
    await mkdir(join(root, 'release'), {recursive: true});
    await writeFile(output, JSON.stringify(rows, null, 2) + '\n');
    return rows.length;
  } catch (error) {
    // Withdrawn approval must not leave a previously approved import artifact.
    await rm(output, {force: true});
    throw error;
  }
}
async function run() {
  if (process.argv.length > 2) throw Error('Invalid arguments');
  const count = await prepareImport();
  console.log(`已產生 ${count} 題私人匯入檔；尚未上載至資料庫或公開網站。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => {console.error('BLOCKED：題目未完成答案、教學及使用權覆核，沒有產生匯入檔。'); process.exitCode = 1;});
}
