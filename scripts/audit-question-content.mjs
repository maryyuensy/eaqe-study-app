import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const alphabet = 'ABCDE';
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const normalise = value => String(value).normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
const validDate = value => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
const genericExplanationPatterns = [
  '其餘選項均把代理權限、私人協議或資料效力說得過於絕對',
  '其餘選項均忽略正式文件、適用條件或主管機關權限'
];
const contextPatterns = ['交易雙方就', '一宗重新設定', '請閱讀以下判斷', '需要判斷'];

// 支援引號、逗號及欄位內換行；不把 CSV 欄位當程式或指令。
export function parseRightsCsv(text) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quoted) {
      if (character === '"' && text[i + 1] === '"') { value += '"'; i++; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') {
      if (value.length) throw new Error('CSV 格式無效');
      quoted = true;
    } else if (character === ',') {
      row.push(value); value = '';
    } else if (character === '\n') {
      row.push(value.replace(/\r$/, '')); rows.push(row); row = []; value = '';
    } else value += character;
  }
  if (quoted) throw new Error('CSV 格式無效');
  if (row.length || value.length) { row.push(value.replace(/\r$/, '')); rows.push(row); }
  const header = rows.shift();
  if (!header?.includes('question_id') || !header.includes('approved_for_publication')) throw new Error('CSV 缺少必要欄位');
  if (new Set(header).size !== header.length) throw new Error('CSV 欄位重複');
  return rows.filter(fields => fields.some(Boolean)).map(fields => {
    if (fields.length !== header.length) throw new Error('CSV 欄位數目不符');
    return Object.fromEntries(header.map((key, index) => [key, fields[index]]));
  });
}

export function questionFingerprint(question) {
  return createHash('sha256').update(JSON.stringify({
    stem: question.stem, options: question.options, answer: question.answer,
    concept: question.concept, explanation: question.explanation, optionNotes: question.optionNotes
  })).digest('hex');
}

// 機器只檢查可觀察的一致性與待覆核訊號；不能證明答案合法、唯一或教學完整。
export function auditQuestionContent(questions, rightsRows = [], reviewRegister = {blockers: []}) {
  if (!Array.isArray(questions) || !questions.length) throw new Error('題庫必須為非空陣列');
  const structuralIssues = [], qualityFlags = [], contradictions = [];
  const ids = new Set(), stems = new Set(), rightsById = new Map();
  for (const row of rightsRows) {
    if (rightsById.has(row.question_id)) structuralIssues.push({id: row.question_id, code: 'duplicate_rights_record'});
    rightsById.set(row.question_id, row);
  }
  const flag = (question, code) => qualityFlags.push({id: question.id, code});
  const issue = (question, code) => structuralIssues.push({id: question.id, code});
  for (const question of questions) {
    if (!question || typeof question !== 'object' || Array.isArray(question)) throw new Error('題目資料無效');
    if (!/^PX-[A-F0-9]{16}$/.test(question.id)) issue(question, 'invalid_id');
    if (ids.has(question.id)) issue(question, 'duplicate_id');
    ids.add(question.id);
    if (!Number.isSafeInteger(question.version) || question.version < 1) issue(question, 'invalid_version');
    if (!Number.isInteger(question.part) || question.part < 1 || question.part > 8) issue(question, 'invalid_part');
    if (!['ready', 'draft', 'suspended'].includes(question.status)) issue(question, 'invalid_status');
    if (!Array.isArray(question.examTracks) || !question.examTracks.length || question.examTracks.some(value => !['eaqe', 'sqe'].includes(value)) || new Set(question.examTracks).size !== question.examTracks.length) issue(question, 'invalid_tracks');
    if (typeof question.free !== 'boolean') issue(question, 'invalid_free_flag');
    for (const field of ['stem', 'concept', 'explanation']) if (!nonEmpty(question[field])) issue(question, `missing_${field}`);
    if (!Array.isArray(question.options) || question.options.length !== 5 || question.options.some(option => !nonEmpty(option))) issue(question, 'incomplete_options');
    else if (new Set(question.options.map(normalise)).size !== 5) issue(question, 'duplicate_options');
    if (!Array.isArray(question.optionNotes) || question.optionNotes.length !== 5 || question.optionNotes.some(note => !nonEmpty(note))) issue(question, 'incomplete_option_notes');
    if (!Number.isInteger(question.answer) || question.answer < 0 || question.answer > 4) issue(question, 'invalid_answer');
    if (nonEmpty(question.stem)) {
      const stem = normalise(question.stem);
      if (stems.has(stem)) issue(question, 'duplicate_stem');
      stems.add(stem);
      if (contextPatterns.some(pattern => question.stem.includes(pattern))) flag(question, 'generic_context_requires_review');
    }
    if (nonEmpty(question.explanation)) {
      if (genericExplanationPatterns.some(pattern => question.explanation.includes(pattern))) flag(question, 'generic_explanation_requires_review');
      const references = [...question.explanation.matchAll(/(?:正確)?答案(?:為|是|[:：])\s*([A-E])(?=[。．.，、：\s]|$)/g)].map(match => alphabet.indexOf(match[1]));
      const ordinal = [...question.explanation.matchAll(/正確答案是第([一二三四五])項/g)].map(match => '一二三四五'.indexOf(match[1]));
      if ([...references, ...ordinal].some(answer => answer !== question.answer)) contradictions.push({id: question.id, code: 'answer_explanation_conflict'});
    }
    if (Array.isArray(question.optionNotes) && question.optionNotes.length === 5 && question.optionNotes.every(nonEmpty)) {
      const positive = question.optionNotes.flatMap((note, index) => /^(?:[A-E]\s*)?正確[。．，：:]/.test(note) ? [index] : []);
      const negativeAnswer = /^(?:[A-E]\s*)?(?:不正確|錯誤)[。．，：:]/.test(question.optionNotes[question.answer] ?? '');
      if (positive.length !== 1 || positive[0] !== question.answer || negativeAnswer) contradictions.push({id: question.id, code: 'answer_option_notes_conflict'});
      if (question.optionNotes.every(note => note.includes('此項把答案定為') || /^[A-E]\s*正確：正確答案是/.test(note))) flag(question, 'option_notes_restate_answer');
    }
    const source = rightsById.get(question.id);
    if (!source || !nonEmpty(source.answer_source) || !validDate(source.verified_date)) flag(question, 'answer_source_unverified');
  }
  if (!reviewRegister || !Array.isArray(reviewRegister.blockers)) throw new Error('人工覆核登記格式無效');
  const activeBlockers = [], changedReviewIds = [], registeredIds = new Set();
  for (const blocker of reviewRegister.blockers) {
    if (!blocker || !/^PX-[A-F0-9]{16}$/.test(blocker.id) || registeredIds.has(blocker.id)) throw new Error('人工覆核 ID 無效或重複');
    registeredIds.add(blocker.id);
    if (!ids.has(blocker.id)) { structuralIssues.push({id: blocker.id, code: 'orphan_review_blocker'}); continue; }
    const current = questions.find(question => question.id === blocker.id);
    if (blocker.status !== 'resolved') {
      activeBlockers.push({id: blocker.id, code: blocker.reasonCode ?? 'manual_review_pending'});
      if (current.version !== blocker.version || (blocker.fingerprint && blocker.fingerprint !== questionFingerprint(current))) changedReviewIds.push(blocker.id);
    }
  }
  const requirements = ['source_type', 'source_reference', 'rights_basis', 'answer_source', 'verified_date', 'reviewer'];
  const rightsApproved = questions.filter(question => {
    const row = rightsById.get(question.id);
    return row?.approved_for_publication === '是' && String(row.version) === String(question.version)
      && requirements.every(field => nonEmpty(row[field])) && validDate(row.verified_date);
  }).map(question => question.id);
  const blockedIds = new Set([...activeBlockers, ...contradictions, ...structuralIssues].map(issue => issue.id));
  const approvedIds = rightsApproved.filter(id => !blockedIds.has(id) && questions.find(question => question.id === id)?.status === 'ready');
  const counts = Object.fromEntries([...new Set(qualityFlags.map(flag => flag.code))].sort().map(code => [code, qualityFlags.filter(flag => flag.code === code).length]));
  return {
    total: questions.length,
    structuralPassed: structuralIssues.length === 0,
    structuralIssues, contradictions, qualityFlagCounts: counts, qualityFlags,
    activeBlockers, changedReviewIds,
    rightsApprovedCount: rightsApproved.length,
    rightsPendingIds: questions.filter(question => !rightsApproved.includes(question.id)).map(question => question.id),
    publicationEligibleIds: approvedIds,
    publicationBlocked: approvedIds.length !== questions.length,
    limits: '結構通過不等於逐題事實、答案唯一性、教學質素或商業使用權已核准；已改動的阻擋題仍需人工重新覆核。'
  };
}

async function run() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--json', '--publication'].includes(arg))) throw new Error('只支援 --json 及 --publication');
  const [questionText, rightsText, registerText] = await Promise.all([
    readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'),
    readFile(new URL('../docs/content-source-rights-audit.csv', import.meta.url), 'utf8'),
    readFile(new URL('../docs/question-review-blockers.json', import.meta.url), 'utf8')
  ]);
  const result = auditQuestionContent(JSON.parse(questionText), parseRightsCsv(rightsText), JSON.parse(registerText));
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`題庫內容檢查：${result.total} 題`);
    console.log(`結構：${result.structuralPassed ? '通過' : '失敗'}；可觀察的答案／解說矛盾：${result.contradictions.length}`);
    console.log(`待人工覆核訊號：${JSON.stringify(result.qualityFlagCounts)}`);
    console.log(`已登記內容阻擋：${result.activeBlockers.length}；改動後仍待重核：${result.changedReviewIds.length}`);
    console.log(`有完整權利審核記錄：${result.rightsApprovedCount}；未核准：${result.rightsPendingIds.length}`);
    console.log(`可發布：${result.publicationEligibleIds.length}；全題庫發布門檻：${result.publicationBlocked ? '未通過' : '通過'}`);
    console.log(result.limits);
  }
  if (!result.structuralPassed || result.contradictions.length || (args.includes('--publication') && result.publicationBlocked)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => { console.error('題庫審核工具失敗：請檢查資料格式或參數；沒有輸出題幹或私人來源。'); process.exitCode = 1; });
}
