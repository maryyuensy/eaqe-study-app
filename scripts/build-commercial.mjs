import {lstat, readFile, writeFile, mkdir, mkdtemp, rename, rm} from 'node:fs/promises';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {auditQuestionContent, parseRightsCsv} from './audit-question-content.mjs';
import {prepareQuestions, publicationFingerprint} from './prepare-question-import.mjs';

// This deliberately does not copy dist wholesale. Approved free questions may
// carry answers for guest practice; paid and unreviewed content must stay private.
export const commercialAssets = Object.freeze([
  'app.js', 'bootstrap.js', 'cloud.js', 'core.js', 'exams.js', 'favicon.svg', 'index.html', 'product.js', 'style.css'
]);
const projectDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const previewBanner = '<aside role="status" data-commercial-preview="empty" style="padding:12px 24px;background:#fff3cd;color:#573e00;text-align:center">內容未核准預覽：目前不提供公開題目。</aside>';

// The original review fingerprint binds educational content only. A public
// release also needs explicit approval of free scope and examination mapping.
export const commercialQuestionFingerprint = publicationFingerprint;

function publicFreeQuestion(row) {
  const answer = row.options.findIndex(option => option.id === row.answer_option_id);
  if (answer < 0 || row.is_free !== true) throw Error('Invalid public projection');
  // An explicit field allowlist prevents private source, reviewer and user data
  // in the input from being serialized into a public question bank.
  return {
    id: row.question_id, version: row.version, status: 'ready', part: row.part, type: '獨立題',
    stem: row.stem, options: row.options.map(option => option.text), answer,
    concept: row.concept, explanation: row.explanation.apply,
    optionNotes: row.options.map(option => row.explanation.options[option.id]),
    examTracks: [...row.tracks], free: true
  };
}

async function readInputs(root) {
  const [questions, rights, blockers, approvals] = await Promise.all([
    readFile(join(root, 'dist/questions.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'docs/content-source-rights-audit.csv'), 'utf8'),
    readFile(join(root, 'docs/question-review-blockers.json'), 'utf8').then(JSON.parse),
    readFile(join(root, 'docs/content-release-approvals.json'), 'utf8').then(JSON.parse)
  ]);
  return {questions, rightsRows: parseRightsCsv(rights), blockers, approvals};
}

async function readAssets(root, excludedQuestions) {
  const assets = new Map();
  const directoryStat = await lstat(join(root, 'dist'));
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw Error('Unsafe static directory');
  for (const name of commercialAssets) {
    const path = join(root, 'dist', name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Unsafe static asset');
    const value = await readFile(path, 'utf8');
    if (/sourceMappingURL\s*=|\bsk_(?:live|test)_[A-Za-z0-9]|\bsk-(?:proj|ant)-[A-Za-z0-9]|\bwhsec_[A-Za-z0-9]|\bsb_secret_[A-Za-z0-9]|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY/.test(value)) throw Error('Private asset reference');
    for (const token of value.matchAll(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g)) {
      let role;
      try { role = JSON.parse(Buffer.from(token[0].split('.')[1], 'base64url').toString('utf8')).role; } catch {}
      if (role === 'service_role') throw Error('Private service token in static asset');
    }
    // Detect accidental bank embedding in otherwise approved runtime assets.
    // This is a guard against build mistakes, not an obfuscation/copyright test.
    for (const question of excludedQuestions) {
      const stem = question.stem;
      if (value.includes(question.id) || (stem.length >= 12 &&
          (value.includes(stem) || value.includes(JSON.stringify(stem).slice(1, -1))))) throw Error('Private question embedded in static asset');
    }
    assets.set(name, value);
  }
  const entry = assets.get('index.html');
  if (!entry.includes('<body>')) throw Error('Unsupported HTML entry');
  for (const script of entry.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\bsrc=["']\.\/bootstrap\.js["']/.test(script[1]) || script[2].trim()) throw Error('Inline or unsupported entry script');
  }
  if (/\bon[a-z]+\s*=|(?:href|src)\s*=\s*["']\s*javascript:/i.test(entry)) throw Error('Inline entry script handler');
  return assets;
}

export async function buildCommercial({rootDirectory = projectDirectory, allowEmptyPreview = false, inputs} = {}) {
  const root = resolve(rootDirectory), release = join(root, 'release'), output = join(release, 'site');
  let staging;
  try {
    const {questions, rightsRows, blockers, approvals} = inputs ?? await readInputs(root);
    const audit = auditQuestionContent(questions, rightsRows, blockers);
    if (!audit.structuralPassed || approvals?.schemaVersion !== 1 || !Array.isArray(approvals.approvals)) throw Error('Invalid release inputs');
    // Empty preview only relaxes the absence of approved content. Stale,
    // contradictory, blocked or incomplete approval records still fail closed.
    const approved = approvals.approvals.length ? prepareQuestions(questions, rightsRows, blockers, approvals) : [];
    const freeRows = approved.filter(row => row.is_free === true);
    // The current import projection handles independent questions only. Do not
    // silently discard a future case's shared stem or question dependencies.
    if (freeRows.some(row => questions.find(question => question.id === row.question_id)?.type !== '獨立題')) throw Error('Unsupported shared case context');
    if (!freeRows.length && !allowEmptyPreview) throw Error('No approved free content');
    const bank = freeRows.map(publicFreeQuestion), publicIds = new Set(bank.map(question => question.id));
    const assets = await readAssets(root, questions.filter(question => !publicIds.has(question.id)));
    const preview = bank.length === 0;
    if (preview) assets.set('index.html', assets.get('index.html').replace('<body>', `<body>${previewBanner}`));
    const reviewedAt = bank.length ? approvals.approvals.filter(approval => publicIds.has(approval.id)).map(approval => approval.reviewedAt).sort().at(-1) : blockers.reviewDate;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reviewedAt ?? '') || new Date(`${reviewedAt}T00:00:00Z`).toISOString().slice(0, 10) !== reviewedAt) throw Error('Invalid release date');
    const status = {
      schemaVersion: 1, status: preview ? 'empty_preview_content_pending' : 'approved_free_ready',
      publicQuestionCount: bank.length, reviewedAt, preview
    };
    assets.set('questions.json', JSON.stringify(bank, null, 2) + '\n');
    assets.set('content-review.json', JSON.stringify({blockedQuestionIds: [], reviewDate: reviewedAt, commercialApprovedCount: bank.length}, null, 2) + '\n');
    assets.set('build-status.json', JSON.stringify(status, null, 2) + '\n');
    await mkdir(release, {recursive: true});
    staging = await mkdtemp(join(release, '.site-build-'));
    await Promise.all([...assets].map(([name, value]) => writeFile(join(staging, name), value, 'utf8')));
    await rm(output, {recursive: true, force: true});
    await rename(staging, output);
    staging = undefined;
    return {...status, outputDirectory: output};
  } catch (error) {
    // A withdrawn approval must not leave a stale deployable commercial site.
    await rm(output, {recursive: true, force: true});
    throw error;
  } finally {
    if (staging) await rm(staging, {recursive: true, force: true});
  }
}

async function run() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--allow-empty-preview') || new Set(args).size !== args.length) throw Error('Invalid arguments');
  const result = await buildCommercial({allowEmptyPreview: args.includes('--allow-empty-preview')});
  console.log(result.preview
    ? '已建立空題庫預覽（內容尚未核准）；未公開、未部署。'
    : `已建立商用靜態輸出：${result.publicQuestionCount} 題已核准免費題；未公開、未部署。`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => {
    console.error('BLOCKED：商用內容或靜態資產未通過發布檢查；沒有可部署的商用輸出。');
    process.exitCode = 1;
  });
}
