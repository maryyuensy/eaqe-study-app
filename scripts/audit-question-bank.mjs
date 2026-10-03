import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const questions = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
const allowedTracks = new Set(['eaqe', 'sqe']);
const counts = (items, key) => Object.fromEntries(
  [...new Set(items.map(item => String(key(item))))]
    .sort((a, b) => a.localeCompare(b, undefined, {numeric: true}))
    .map(value => [value, items.filter(item => String(key(item)) === value).length])
);
const duplicateCount = values => values.length - new Set(values).size;

assert.ok(Array.isArray(questions) && questions.length > 0, '題庫必須為非空陣列');

const issues = [];
for (const question of questions) {
  if (!/^PX-[A-F0-9]{16}$/.test(question.id)) issues.push(`${question.id}: ID 格式無效`);
  if (!Number.isInteger(question.version) || question.version < 1) issues.push(`${question.id}: 版本無效`);
  if (!Number.isInteger(question.part) || question.part < 1 || question.part > 8) issues.push(`${question.id}: 綱要部分無效`);
  if (!Array.isArray(question.examTracks) || question.examTracks.length === 0 || question.examTracks.some(track => !allowedTracks.has(track))) issues.push(`${question.id}: 考試分類無效`);
  if (typeof question.free !== 'boolean') issues.push(`${question.id}: 免費標記無效`);
  if (typeof question.stem !== 'string' || !question.stem.trim()) issues.push(`${question.id}: 缺少題幹`);
  if (!Array.isArray(question.options) || question.options.length !== 5) issues.push(`${question.id}: 選項數目不是五項`);
  if (!Number.isInteger(question.answer) || question.answer < 0 || question.answer >= (question.options?.length ?? 0)) issues.push(`${question.id}: 正確答案索引無效`);
  if (!Array.isArray(question.optionNotes) || question.optionNotes.length !== 5) issues.push(`${question.id}: 選項分析不完整`);
  if (typeof question.concept !== 'string' || !question.concept.trim()) issues.push(`${question.id}: 缺少考核概念`);
  if (typeof question.explanation !== 'string' || !question.explanation.trim()) issues.push(`${question.id}: 缺少解說`);
}

const eaqe = questions.filter(question => question.examTracks.includes('eaqe'));
const sqe = questions.filter(question => question.examTracks.includes('sqe'));
const eaqeIds = new Set(eaqe.map(question => question.id));
const sqeIds = new Set(sqe.map(question => question.id));
const shared = questions.filter(question => question.examTracks.includes('eaqe') && question.examTracks.includes('sqe'));
const freeByPart = counts(questions.filter(question => question.free), question => question.part);
const sourceFields = ['source', 'sourceReference', 'sourceReviewDate', 'licenseBasis'];
const provenanceTracked = questions.every(question => sourceFields.some(field => Object.hasOwn(question, field)));
const statusCounts = counts(questions, question => question.status ?? '(未標示)');
const versions = counts(questions, question => question.version);
const byPart = counts(questions, question => question.part);
const repeatedStems = duplicateCount(questions.map(question => question.stem.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim()));

if (duplicateCount(questions.map(question => question.id)) > 0) issues.push('題目 ID 重複');
if (repeatedStems > 0) issues.push('正規化後題幹重複');
if (eaqeIds.size !== eaqe.length || sqeIds.size !== sqe.length) issues.push('同一考試範圍內有重複 ID');

console.log('地產牌研所題庫盤點');
console.log(`總題數：${questions.length}`);
console.log(`免費題：${questions.filter(question => question.free).length}；按綱要部分：${JSON.stringify(freeByPart)}`);
console.log(`EAQE：${eaqe.length}；SQE：${sqe.length}；同一題目 ID 標記兩考試：${shared.length}`);
console.log(`只標記 EAQE：${questions.filter(question => question.examTracks.includes('eaqe') && !question.examTracks.includes('sqe')).length}；只標記 SQE：${questions.filter(question => question.examTracks.includes('sqe') && !question.examTracks.includes('eaqe')).length}`);
console.log(`按綱要部分：${JSON.stringify(byPart)}`);
console.log(`內容版本：${JSON.stringify(versions)}`);
console.log(`題目狀態：${JSON.stringify(statusCounts)}`);
console.log(`重複 ID：${duplicateCount(questions.map(question => question.id))}；重複題幹：${repeatedStems}`);
console.log(`來源／使用權審核欄位：${provenanceTracked ? '有資料欄位' : '未包含於題目資料，需另行核實'}`);
console.log('注意：本盤點驗證資料欄位與分類，不代表題目準確性、官方分類、內容來源或商業使用權已獲認證。');

if (issues.length) {
  console.error(`資料檢查失敗（${issues.length} 項）：`);
  for (const issue of issues) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log('結構檢查：通過');
}
