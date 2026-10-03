import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {examPassWindow, exams, registrationStatus, selectableExams, verifiedAt} from '../dist/exams.js';
import {product} from '../dist/product.js';

const questions = JSON.parse(await readFile(new URL('../dist/questions.json', import.meta.url), 'utf8'));
const app = await readFile(new URL('../dist/app.js', import.meta.url), 'utf8');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

assert.equal(product.price, 359, '首批用戶試行價應為 HK$359');
assert.equal(product.approxAccessDays, product.preExamDays + product.postExamDays, '標示的約 70 日須與考前及考後期間一致');
assert.equal(product.preExamDays, 60, '通行證應由考前 60 日開始');
assert.equal(product.postExamDays, 10, '通行證應在考試後 10 日到期');
assert.deepEqual(
  examPassWindow('2026-10-20'),
  {accessOpensOn: '2026-08-21', accessEndsOn: '2026-10-30'},
  '考期通行證日期應以考前 60 日及考後第 10 日計算'
);
assert.deepEqual(
  examPassWindow('2026-09-22'),
  {accessOpensOn: '2026-07-24', accessEndsOn: '2026-10-02'},
  'EAQE 示例期限應正確顯示至考後第 10 日'
);
assert.throws(() => examPassWindow('2026-02-30'), RangeError, '無效考期不可建立通行證期間');
assert.equal(questions.filter(question => question.free).length, 20, '免費題數應為 20');
assert.ok(questions.filter(question => question.free).every(question => question.part === 1));

assert.equal(verifiedAt, '2026-10-02', '官方考期核實日期應反映本次查核');
assert.deepEqual(
  selectableExams('2026-10-02', '2026-09-22', 'eaqe').map(exam => exam.date),
  ['2026-12-15'],
  'EAQE 選單只能顯示核實日期後仍未舉行的場次'
);
assert.deepEqual(
  selectableExams('2026-10-02', '', 'sqe').map(exam => exam.date),
  ['2026-10-20', '2026-11-17'],
  'SQE 選單只能顯示核實日期後仍未舉行的場次'
);
assert.equal(registrationStatus(exams.find(exam => exam.date === '2026-10-20'), '2026-10-02'), '報名期內・名額以官方為準');
assert.equal(registrationStatus(exams.find(exam => exam.date === '2026-10-20'), '2026-10-07'), '報名已截止');

assert.match(app, /20 題免費試做/);
assert.match(app, /付款尚未開放/);
assert.match(app, /考前 \$\{product\.preExamDays\} 日/);
assert.match(app, /考後 \$\{product\.postExamDays\} 日/);
assert.match(app, /未合格後報考下一場須重新購買/);
assert.match(app, /Qualifying-examinations-results/);
assert.doesNotMatch(app, /HK\$238|第一部分免費體驗|免費重考/);
assert.match(readme, /HK\$359／每場考期/);
assert.match(readme, /考前 60 日開始、考試結束後 10 日到期/);
assert.match(readme, /成績可能在通行證到期後才公布/);
assert.match(readme, /個別題目來源及商業使用權仍須逐題審核/);

console.log('PASS: 首批價格與期限、20 題免費範圍、已公布考期、報名狀態及未收款文案。');
