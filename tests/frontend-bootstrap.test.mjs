import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const html=await readFile(new URL('../dist/index.html',import.meta.url),'utf8');
const bootstrap=await readFile(new URL('../dist/bootstrap.js',import.meta.url),'utf8');
test('external deferred bootstrap preserves file preview guidance without requiring inline scripts',()=>{
 assert.match(html,/<script src="\.\/bootstrap\.js" defer><\/script>/);assert.doesNotMatch(html,/<script(?:\s[^>]*)?>\s*[^<\s]/);const main={innerHTML:''};let imports=0;runInNewContext(bootstrap.replace("import('./app.js')","loadApp()"),{location:{protocol:'file:'},document:{querySelector:()=>main},loadApp:()=>{imports++;return Promise.resolve();}});assert.equal(imports,0);assert.match(main.innerHTML,/請開啟網站預覽/);assert.match(main.innerHTML,/http:\/\/localhost:5173\/#home/);
});
test('failed module loading presents a visible retry link instead of an indefinite spinner',async()=>{
 const main={innerHTML:'正在載入題庫…'};let imports=0;runInNewContext(bootstrap.replace("import('./app.js')","loadApp()"),{location:{protocol:'http:'},document:{querySelector:()=>main},loadApp:()=>{imports++;return Promise.reject(Error('blocked'));}});await Promise.resolve();assert.equal(imports,1);assert.match(main.innerHTML,/載入失敗/);assert.match(main.innerHTML,/href="\.\/"/);assert.doesNotMatch(main.innerHTML,/正在載入題庫/);
});
