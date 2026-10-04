import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createApplication} from '../lib/application.mjs';
const src=await readFile(new URL('../dist/cloud.js',import.meta.url),'utf8');
const {ApiClient,AccountOutbox}=await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`);
const ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222'};
const origin='https://study.example.test';
function setup(){
 let cookie='pe_access=account-a';const accepted=[];let logoutCalls=0;
 const app=createApplication({env:{APP_ENV:'test',DATA_ENV:'test',APP_BASE_URL:origin,SUPABASE_URL:'https://project.example.test',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SUPABASE_SECRET_KEY:'sb_secret_test',AUTH_ENABLED:'true',APP_TERMS_VERSION:'test-v1',APP_PRIVACY_VERSION:'test-v1'},logger:()=>{},provider:{
  getUser:async token=>({id:token==='account-a'?ids.a:ids.b,email:token+'@example.test',verified:true}),
  adminRpc:async()=>({allowed:true}),
  rpc:async(name,params,token)=>{accepted.push({name,params,token});return {totals:{foregroundSeconds:5,effectiveSeconds:0}};},
  auth:async()=>{logoutCalls++;return {};}
 }});
 const api=new ApiClient({fetcher:async(path,options)=>app.fetch(new Request(origin+path,{method:options.method,headers:{Origin:origin,Cookie:cookie,...options.headers},...(options.body?{body:options.body}:{})}))});api.expectedAccountId=ids.a;
 return {api,accepted,setCookie:value=>cookie=value,getLogoutCalls:()=>logoutCalls};
}
test('real API rejects stale A queue when shared Cookie changes to B, then accepts exactly once under A',async()=>{
 const fixture=setup(),values=new Map(),storage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
 const outbox=new AccountOutbox({storage,api:fixture.api});outbox.activate(ids.a);outbox.enqueue('usage',{eventId:'33333333-3333-4333-8333-333333333333',deviceId:'device-a',segments:[{id:'44444444-4444-4444-8444-444444444444',startAt:'2026-10-04T10:00:00Z',endAt:'2026-10-04T10:00:05Z',kind:'foreground'}]});
 fixture.setCookie('pe_access=account-b');await outbox.flush();assert.equal(fixture.accepted.length,0);assert.equal(outbox.pending,1);assert.equal(outbox.paused,true);assert.equal(outbox.events[0].terminal,false);
 fixture.setCookie('pe_access=account-a');outbox.deactivate();outbox.activate(ids.a);await outbox.flush({manual:true});await outbox.flush();assert.equal(fixture.accepted.length,1);assert.equal(fixture.accepted[0].token,'account-a');assert.equal(fixture.accepted[0].params.p_request.eventId,'33333333-3333-4333-8333-333333333333');assert.equal(outbox.pending,0);
});
test('real API refuses stale tab settings and logout under another account Cookie',async()=>{
 const fixture=setup();fixture.setCookie('pe_access=account-b');await assert.rejects(fixture.api.request('/api/settings',{method:'PUT',body:{expectedVersion:1,settings:{track:'eaqe',examDate:''}}}),{code:'account_mismatch',status:409});await assert.rejects(fixture.api.request('/api/auth/logout',{method:'POST',body:{}}),{code:'account_mismatch',status:409});assert.equal(fixture.accepted.length,0);assert.equal(fixture.getLogoutCalls(),0);
});
