import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {initial,submitAnswer,firstAttempts,percent,playable,KEY,REVIEW_SUCCESSES_REQUIRED} from './dist/core.js';

const playwrightPath=process.env.PLAYWRIGHT_PATH||join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs');
const {chromium}=await import(pathToFileURL(playwrightPath));

const questions=JSON.parse(await readFile(new URL('./dist/questions.json',import.meta.url),'utf8'));
const baseUrl=process.env.BASE_URL||'http://localhost:5173';
const orderSeed='propexam-hk-display-order-v2:41';
const allowedKeys=new Set(['id','version','status','part','type','stem','options','answer','concept','explanation','optionNotes','examTracks','free']);
const forbiddenKeys=['source','sourcePath','sourceLabel','sources','chapter','set','setLabel','number','originalNumber','previousAnswer','previousResult','priority','reason','inclusion','organisedAt','totalInSet','sourceType'];

assert.equal(questions.length,484,'公開題庫應包含 484 題');
assert.equal(new Set(questions.map(question=>question.id)).size,484,'題目 ID 必須唯一');
assert.ok(questions.every(question=>/^PX-[A-F0-9]{16}$/.test(question.id)),'公開題目 ID 不得帶有來源次序');
assert.equal(new Set(questions.map(question=>question.stem)).size,484,'題幹不得重複');
assert.ok(questions.every(question=>new Set(question.options).size===5),'同一題內的選項不得重複');
const expectedOrder=[...questions].sort((a,b)=>Buffer.compare(
  createHash('sha256').update(`${orderSeed}\0${a.id}`).digest(),
  createHash('sha256').update(`${orderSeed}\0${b.id}`).digest()
));
assert.deepEqual(questions.map(question=>question.id),expectedOrder.map(question=>question.id),'公開題序必須採用固定隨機排序');
assert.ok(questions.every(question=>playable(question)),'每題必須可正式作答');
assert.ok(questions.every(question=>question.options.length===5&&question.optionNotes.length===5),'每題須有五個選項及五項分析');
assert.ok(questions.every(question=>Object.keys(question).every(key=>allowedKeys.has(key))),'題庫含有未獲准的欄位');
assert.ok(questions.every(question=>forbiddenKeys.every(key=>!(key in question))),'題庫含有私人來源欄位');
assert.doesNotMatch(JSON.stringify(questions),/(?:WRONG-|IMG_\d+|\.HEIC|\.MOV|使用者答案|使用者不確定|個人答題|書本答案|錯題集來源)/i,'題庫含有私人教材或作答來源文字');
assert.deepEqual(Object.fromEntries([...Array(8)].map((_,index)=>[index+1,questions.filter(question=>question.part===index+1).length])),{1:20,2:168,3:117,4:61,5:36,6:14,7:40,8:28});
assert.equal(questions.filter(question=>question.examTracks.includes('eaqe')).length,484);
assert.equal(questions.filter(question=>question.examTracks.includes('sqe')).length,442);
assert.equal(questions.filter(question=>question.free).length,20);
assert.ok(questions.filter(question=>question.free).every(question=>question.part===1));

const state=initial();
const [sample,uncertainSample]=questions;
let unitSession=0;
const answer=(question,choice,uncertain,iso)=>{
  state.session={id:`unit-${++unitSession}`,ids:[question.id],index:0,result:null,activeMs:9000,mode:'review'};
  return submitAnswer(state,question,choice,uncertain,Date.parse(iso));
};
const attempt=answer(sample,(sample.answer+1)%5,false,'2026-09-22T04:00:00Z');
assert.equal(attempt.correct,false);
assert.equal(state.reviews[sample.id].status,'wrong','答錯須加入錯題重溫');
answer(uncertainSample,uncertainSample.answer,true,'2026-09-22T04:10:00Z');
assert.equal(state.reviews[uncertainSample.id].status,'uncertain','答對但不確定亦須加入重溫');
assert.equal(Object.keys(state.reviews).length,2);
answer(sample,sample.answer,false,'2026-09-23T04:00:00Z');
assert.equal(state.reviews[sample.id].successes,1,'首次答對只完成一次鞏固');
answer(sample,sample.answer,false,'2026-09-23T05:00:00Z');
assert.equal(state.reviews[sample.id].successes,1,'同日重複答對不可重複計算');
answer(sample,sample.answer,false,'2026-09-24T04:00:00Z');
assert.equal(state.reviews[sample.id],undefined,'兩個不同日期答對後須移出錯題集');
assert.equal(Object.keys(state.reviews).length,1,'錯題數須隨掌握進度減少');
answer(uncertainSample,uncertainSample.answer,false,'2026-09-23T04:10:00Z');
assert.equal(state.reviews[uncertainSample.id].successes,1);
answer(uncertainSample,(uncertainSample.answer+1)%5,false,'2026-09-24T04:10:00Z');
assert.equal(state.reviews[uncertainSample.id].status,'wrong','鞏固期間再次答錯須保留並重設進度');
assert.equal(state.reviews[uncertainSample.id].successes,0);
answer(uncertainSample,uncertainSample.answer,false,'2026-09-25T04:10:00Z');
answer(uncertainSample,uncertainSample.answer,false,'2026-09-26T04:10:00Z');
assert.equal(Object.keys(state.reviews).length,0,'所有題目完成兩日鞏固後錯題集須清空');
assert.equal(REVIEW_SUCCESSES_REQUIRED,2);
assert.equal(firstAttempts(state).length,2);
assert.equal(percent(firstAttempts(state)),50);

await mkdir(new URL('./qa/',import.meta.url),{recursive:true});
const browser=await chromium.launch({headless:true,channel:'chrome'});
const errors=[];
const desktop=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'Asia/Hong_Kong'});
const page=await desktop.newPage();
await page.clock.install({time:new Date('2026-09-22T12:00:00+08:00')});
page.on('pageerror',error=>errors.push(error.message));

await page.goto(`${baseUrl}/#home`);
await page.getByRole('heading',{name:/先做題/}).waitFor();
assert.match(await page.locator('.product-proof').innerText(),/484/);
assert.equal(await page.title(),'主頁｜地產牌研所');
await page.evaluate(()=>localStorage.setItem('eaqe-prototype-v1',JSON.stringify({private:true})));
await page.evaluate(()=>localStorage.setItem('propexam-hk-v2',JSON.stringify({test:true})));
await page.reload({waitUntil:'networkidle'});
assert.equal(await page.evaluate(()=>localStorage.getItem('eaqe-prototype-v1')),null,'舊私人紀錄須被清除');
assert.equal(await page.evaluate(()=>localStorage.getItem('propexam-hk-v2')),null,'舊測試紀錄須被清除');
await page.screenshot({path:new URL('./qa/desktop-home.png',import.meta.url).pathname,fullPage:true});

await page.goto(`${baseUrl}/#practice`);
await page.getByRole('heading',{name:'練習題庫',exact:true}).waitFor();
assert.match(await page.locator('.practice-overview').innerText(),/484/);
assert.equal(await page.locator('.set-list .chapter-row').count(),8);
assert.equal(await page.locator('.locked-link').count(),7);
await page.screenshot({path:new URL('./qa/desktop-practice.png',import.meta.url).pathname,fullPage:true});

await page.locator('[data-action="start-part"]').click();
await page.getByRole('heading',{level:1}).filter({hasText:/./}).waitFor();
assert.equal(await page.locator('.feedback').count(),0,'提交前不可顯示答案');
const currentStem=await page.locator('#question-title').innerText();
const correctIndex=questions.find(question=>question.stem===currentStem).answer;
const wrongIndex=(correctIndex+1)%5;
await page.getByRole('radio').nth(wrongIndex).check();
await page.getByRole('button',{name:'提交答案',exact:true}).click();
await page.locator('.feedback.error').waitFor();
assert.match(await page.locator('.feedback').innerText(),/核心概念/);
assert.equal(await page.locator('.feedback details').count(),1);
assert.equal(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).attempts.length,KEY),1);
assert.equal(await page.evaluate(key=>Object.keys(JSON.parse(localStorage.getItem(key)).reviews).length,KEY),1);
await page.reload();
await page.locator('.feedback.error').waitFor();
await page.screenshot({path:new URL('./qa/desktop-answer.png',import.meta.url).pathname,fullPage:true});

await page.goto(`${baseUrl}/#history`);
await page.getByRole('heading',{name:'錯題與練習紀錄',exact:true}).waitFor();
assert.match(await page.locator('.analysis-stats').innerText(),/待重溫/);
assert.equal(await page.locator('.record-row').count(),2,'待重溫及全部已完成各顯示一次');
await page.goto(`${baseUrl}/#concepts`);
await page.getByRole('heading',{name:'弱項概念',exact:true}).waitFor();
assert.equal(await page.locator('.concept-note').count(),1);

await page.goto(`${baseUrl}/#history`);
await page.locator('.record-section').filter({has:page.getByRole('heading',{name:'待重溫',exact:true})}).getByRole('button',{name:/再做一次/}).click();
await page.getByRole('button',{name:'開始',exact:true}).click();
await page.getByRole('radio').nth(correctIndex).check();
await page.getByRole('button',{name:'提交答案',exact:true}).click();
await page.locator('.feedback:not(.error)').waitFor();
assert.equal(await page.evaluate(key=>Object.values(JSON.parse(localStorage.getItem(key)).reviews)[0].successes,KEY),1);
await page.goto(`${baseUrl}/#history`);
assert.match(await page.locator('.record-section').first().innerText(),/鞏固進度 1 \/ 2/);

await page.clock.setSystemTime(new Date('2026-09-23T12:00:00+08:00'));
await page.locator('.record-section').filter({has:page.getByRole('heading',{name:'待重溫',exact:true})}).getByRole('button',{name:/再做一次/}).click();
await page.getByRole('button',{name:'開始',exact:true}).click();
await page.getByRole('radio').nth(correctIndex).check();
await page.getByRole('button',{name:'提交答案',exact:true}).click();
await page.locator('.feedback:not(.error)').waitFor();
assert.equal(await page.evaluate(key=>Object.keys(JSON.parse(localStorage.getItem(key)).reviews).length,KEY),0,'兩個不同日期答對後待重溫須歸零');
await page.goto(`${baseUrl}/#history`);
assert.equal(await page.locator('.record-section').first().locator('.record-row').count(),0,'已掌握題目須自動移出待重溫');
await page.goto(`${baseUrl}/#concepts`);
await page.getByRole('heading',{name:'尚未建立弱項',exact:true}).waitFor();

await page.goto(`${baseUrl}/#learning`);
await page.getByRole('button',{name:/細牌/}).click();
await page.goto(`${baseUrl}/#practice`);
assert.match(await page.locator('.practice-overview').innerText(),/442/);
assert.equal(await page.locator('.set-list .chapter-row').count(),6);
assert.equal(await page.locator('.set-list .chapter-number').last().innerText(),'06');

await page.goto(`${baseUrl}/#pricing`);
await page.getByRole('heading',{name:'用 60 日完成一輪有系統的備試',exact:true}).waitFor();
assert.match(await page.locator('.pricing-grid').innerText(),/HK\$238/);
await page.getByRole('button',{name:/購買 60 日通行證/}).click();
assert.match(await page.locator('dialog').innerText(),/現時不會收取款項/);
await page.getByRole('button',{name:'✕'}).click();

await page.evaluate(key=>{const state=JSON.parse(localStorage.getItem(key));state.settings.track='eaqe';state.entitlement={plan:'full',expiresAt:'2099-12-31'};localStorage.setItem(key,JSON.stringify(state))},KEY);
await page.reload();
await page.goto(`${baseUrl}/#practice`);
await page.getByRole('heading',{name:'練習題庫',exact:true}).waitFor();
assert.equal(await page.locator('.locked-link').count(),0);
assert.equal(await page.locator('[data-action="start-part"]').count(),8);
await page.goto(`${baseUrl}/#analysis`);
await page.getByRole('heading',{name:'學習進度',exact:true}).waitFor();
assert.match(await page.locator('.analysis-stats').innerText(),/1 \/ 484/);
await page.getByRole('button',{name:'設定'}).click();
assert.match(await page.locator('dialog').innerText(),/只儲存在這個瀏覽器/);
await page.getByRole('button',{name:'清除本機紀錄'}).click();
await page.getByRole('button',{name:'確認清除'}).click();
assert.equal(await page.evaluate(key=>localStorage.getItem(key),KEY),null);

const mobile=await browser.newContext({viewport:{width:390,height:844},isMobile:true,deviceScaleFactor:1,timezoneId:'Asia/Hong_Kong'});
const mobilePage=await mobile.newPage();
mobilePage.on('pageerror',error=>errors.push(error.message));
for(const width of [320,390,768,1440]){
  await mobilePage.setViewportSize({width,height:900});
  for(const hash of ['home','learning','practice','analysis','pricing']){
    await mobilePage.goto(`${baseUrl}/#${hash}`);
    await mobilePage.locator('main').waitFor();
    assert.equal(await mobilePage.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`水平溢出：${width}px #${hash}`);
  }
}
await mobilePage.setViewportSize({width:390,height:844});
await mobilePage.goto(`${baseUrl}/#home`);
await mobilePage.screenshot({path:new URL('./qa/mobile-home.png',import.meta.url).pathname,fullPage:true});

const filePage=await desktop.newPage();
await filePage.goto('file://'+new URL('./dist/index.html',import.meta.url).pathname);
await filePage.getByRole('heading',{name:'請開啟網站預覽'}).waitFor();
assert.deepEqual(errors,[]);
await browser.close();
console.log('PASS: 484 題公開題庫、私人資料清理、EAQE/SQE 分流、免費限制、錯題兩日鞏固至清空及 320–1440px 版面。');
