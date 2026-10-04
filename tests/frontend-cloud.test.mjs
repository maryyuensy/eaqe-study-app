import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
const source=await readFile(new URL('../dist/cloud.js',import.meta.url),'utf8');
const {ApiClient,AccountOutbox,CloudError,safeReturnRoute,cloudSnapshotToState,applyCloudAttempt,applySyncEvent,errorMessage}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const storage=()=>{const values=new Map();return {getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};};
const response=(status,data)=>({status,ok:status>=200&&status<300,json:async()=>data});
test('actual HTTP fetch retains only validated server request IDs from error headers or JSON',async()=>{
 const headerId='12345678-1234-4000-8000-123456789abc',bodyId='abcdef12-1234-4000-8000-123456789abc';
 const variants={
  '/api/header-error':{header:headerId,body:{requestId:bodyId}},
  '/api/body-error':{body:{requestId:bodyId}},
  '/api/nested-error':{body:{error:{requestId:bodyId}}},
  '/api/invalid-id':{header:'not-a-reference',body:{requestId:'jwt.payload.signature',error:{requestId:'<script>secret</script>'}}},
  '/api/missing-id':{body:{privatePayload:'synthetic-secret-must-not-display'}}
 };
 const server=createServer((request,response)=>{const value=variants[request.url];response.writeHead(value?503:404,{'Content-Type':'application/json',...(value?.header?{'X-Request-ID':value.header}:{})});response.end(JSON.stringify({...value?.body,error:{code:'service_unavailable',message:'服務暫時無法使用。',...value?.body?.error}}));});
 try{
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const api=new ApiClient({fetcher:(path,options)=>fetch(`http://127.0.0.1:${server.address().port}${path}`,options)});
  for(const [path,expected]of [['/api/header-error',headerId],['/api/body-error',bodyId],['/api/nested-error',bodyId],['/api/invalid-id',undefined],['/api/missing-id',undefined]]){
   await assert.rejects(api.request(path),error=>{assert.equal(error.code,'service_unavailable');assert.equal(error.status,503);assert.equal(error.requestId,expected);assert.equal(error.message,'服務暫時無法使用。');assert.equal(errorMessage(error),expected?`服務暫時無法使用。（參考碼：${expected}）`:'服務暫時無法使用。');assert.doesNotMatch(errorMessage(error),/synthetic-secret|jwt\.payload|<script>/);assert.equal(error.privatePayload,undefined);return true;});
  }
 }finally{server.closeIdleConnections();if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
});
test('malformed or unknown request ID metadata is never shown as a reference',()=>{
 const id='12345678-1234-4000-8000-123456789abc';
 for(const value of [undefined,null,42,{},'',id+'\n',' '+id,id+'extra',id.replaceAll('-',''),id.replace('-4000-8000-','-f000-7000-'),'jwt.payload.signature','<img src=x onerror=alert(1)>']){
  const error=new CloudError('failed','請稍後再試。',503,value);assert.equal(error.requestId,undefined);assert.equal(errorMessage(error),'請稍後再試。');
  assert.equal(errorMessage({message:'請稍後再試。',requestId:value}),'請稍後再試。');
 }
 assert.equal(errorMessage({message:'請稍後再試。',request_id:id,token:'secret'}),'請稍後再試。');
 assert.equal(errorMessage(new CloudError('conflict','原訊息。',409,id),'設定已有更新。'),`設定已有更新。（參考碼：${id}）`);
});
test('unreadable server response keeps a valid response header reference and no raw body',async()=>{
 const id='12345678-1234-4000-8000-123456789abc';const api=new ApiClient({fetcher:async()=>new Response('private provider response must not display',{status:503,headers:{'X-Request-ID':id}})});
 await assert.rejects(api.request('/api/account'),error=>{assert.equal(error.code,'invalid_response');assert.equal(error.requestId,id);assert.equal(errorMessage(error),`伺服器回覆無法讀取。（參考碼：${id}）`);assert.doesNotMatch(errorMessage(error),/private provider/);return true;});
});
test('failed outbox shows the server reference while preserving the original event and payload',async()=>{
 const id='12345678-1234-4000-8000-123456789abc';const api=new ApiClient({fetcher:async()=>Response.json({error:{code:'service_unavailable',message:'同步服務暫時無法使用。'},requestId:id},{status:503})});const outbox=new AccountOutbox({storage:storage(),api,uuid:()=> 'event-1'});outbox.activate('user-a');outbox.enqueue('attempt',{optionId:'opt-a'});const payload=JSON.stringify(outbox.events[0].payload);await outbox.flush();assert.equal(outbox.pending,1);assert.equal(outbox.events[0].id,'event-1');assert.equal(JSON.stringify(outbox.events[0].payload),payload);assert.equal(outbox.events[0].terminal,false);assert.equal(outbox.lastError,`同步服務暫時無法使用。（參考碼：${id}）`);
});
test('API uses only same-origin cookie credentials and explicit mutation marker',async()=>{
 const calls=[];const api=new ApiClient({fetcher:async(path,options)=>{calls.push({path,options});return response(200,{ok:true});}});
 await api.request('/api/attempts',{method:'POST',body:{selected:'option-a'}});
 assert.equal(calls[0].options.credentials,'same-origin');assert.equal(calls[0].options.headers['X-App-Request'],'1');assert.equal(calls[0].options.headers.Authorization,undefined);
 for(const path of ['https://other.test/api/account','//other.test/api/account','/api/../private','/api/auth/callback#token','/outside'])await assert.rejects(api.request(path),{code:'invalid_path'});
});
test('expired authentication refreshes once, then stops on continued failure',async()=>{
 const calls=[];const api=new ApiClient({fetcher:async path=>{calls.push(path);return path==='/api/auth/refresh'?response(200,{ok:true}):response(401,{error:{code:'unauthenticated',message:'請登入。'}});}});
 await assert.rejects(api.request('/api/account'),{status:401});assert.deepEqual(calls,['/api/account','/api/auth/refresh','/api/account']);
});
test('account-bound data carries only a consistency guard and account discovery is unbound',async()=>{
 const calls=[];const api=new ApiClient({fetcher:async(path,options)=>{calls.push({path,options});return response(200,{});}});api.expectedAccountId='verified-account-a';await api.request('/api/usage',{method:'POST',body:{eventId:'event-1'}});await api.request('/api/settings',{method:'PUT',body:{settings:{}}});await api.request('/api/account');await api.request('/api/auth/logout',{method:'POST',body:{}});
 assert.equal(calls[0].options.headers['X-App-Account'],'verified-account-a');assert.equal(calls[1].options.headers['X-App-Account'],'verified-account-a');assert.equal(calls[2].options.headers['X-App-Account'],undefined);assert.equal(calls[3].options.headers['X-App-Account'],'verified-account-a');
});
test('account mismatch pauses original queue, then permits same event retry only after matching login',async()=>{
 const data=storage();let mismatch=true,count=0;const api={request:async()=>{count++;if(mismatch)throw new CloudError('account_mismatch','帳戶已切換。',409);return {accepted:true};}};const outbox=new AccountOutbox({storage:data,api,uuid:()=> 'event-1'});outbox.activate('user-a');outbox.enqueue('usage',{deviceId:'a'});await outbox.flush();assert.equal(outbox.paused,true);assert.equal(outbox.events[0].terminal,false);await outbox.flush();assert.equal(count,1);outbox.deactivate();outbox.activate('user-a');mismatch=false;await outbox.flush({manual:true});assert.equal(count,2);assert.equal(outbox.pending,0);
});
test('events persist before network access and storage failure prevents submission',async()=>{
 let sent=0;const data=storage();const api={request:async()=>{sent++;return {accepted:true};}};const outbox=new AccountOutbox({storage:data,api,uuid:()=> 'event-1'});outbox.activate('user-a');outbox.enqueue('attempt',{question_id:'q1'});
 assert.equal(sent,0);assert.match(data.getItem(outbox.key),/event-1/);await outbox.flush();assert.equal(sent,1);assert.equal(outbox.pending,0);
 const broken=new AccountOutbox({storage:{getItem:()=>null,setItem:()=>{throw Error('disk');}},api,uuid:()=> 'event-2'});broken.activate('user-b');assert.throws(()=>broken.enqueue('attempt',{}),{code:'storage_error'});assert.equal(sent,1);
});
test('persisted retry reuses the event ID and removes only server-acknowledged data',async()=>{
 const data=storage();let count=0;const sent=[];const api={request:async(path,{body})=>{sent.push(body.eventId);if(count++===0)throw new CloudError('network_error','連線中斷。');return {accepted:true};}};
 const first=new AccountOutbox({storage:data,api,uuid:()=> 'event-1',now:()=>0});first.activate('user-a');first.enqueue('attempt',{question_id:'q1'});await first.flush();assert.equal(first.pending,1);
 const resumed=new AccountOutbox({storage:data,api,now:()=>10000});resumed.activate('user-a');await resumed.flush();assert.deepEqual(sent,['event-1','event-1']);assert.equal(resumed.pending,0);
});
test('account switching never sends an old account event with a new account identity',async()=>{
 const data=storage();let resolve;const pending=new Promise(r=>resolve=r);const sent=[];const api={request:async(path,{body})=>{sent.push(body.eventId);await pending;return {accepted:true};}};
 const outbox=new AccountOutbox({storage:data,api,uuid:()=> 'event-a'});outbox.activate('user-a');outbox.enqueue('attempt',{question_id:'q1'});const flush=outbox.flush();outbox.deactivate();outbox.activate('user-b');assert.equal(outbox.pending,0);resolve();await flush;assert.equal(outbox.pending,0);assert.deepEqual(sent,['event-a']);outbox.activate('user-a');assert.equal(outbox.pending,1);
});
test('401 pauses automatic retry; invalid event is retained without retry loop',async()=>{
 let calls=0;let status=401;const outbox=new AccountOutbox({storage:storage(),api:{request:async()=>{calls++;throw new CloudError('failed','未完成。',status);}},now:()=>100000,uuid:()=> 'event-1'});outbox.activate('user-a');outbox.enqueue('attempt',{});await outbox.flush();await outbox.flush();assert.equal(calls,1);assert.equal(outbox.paused,true);
 status=422;await outbox.flush({manual:true});await outbox.flush({manual:true});assert.equal(calls,2);assert.equal(outbox.events[0].terminal,true);assert.equal(outbox.pending,1);
});
test('same event with altered body is rejected and retry count is bounded',async()=>{
 let now=0,calls=0;const outbox=new AccountOutbox({storage:storage(),api:{request:async()=>{calls++;throw new CloudError('network_error','未完成。');}},now:()=>now,uuid:()=> 'event-1'});outbox.activate('user-a');outbox.enqueue('attempt',{choice:'a'});assert.throws(()=>outbox.enqueue('attempt',{eventId:'event-1',choice:'b'}),{code:'event_conflict'});
 for(let i=0;i<10;i++){now+=100000;await outbox.flush();}assert.equal(calls,5);assert.equal(outbox.pending,1);
});
test('no private prototype data is migrated or used as entitlement evidence',()=>{
 const data=storage();data.setItem('propexam-hk-v3',JSON.stringify({attempts:[{private:true}],entitlement:{plan:'full'}}));const outbox=new AccountOutbox({storage:data});outbox.activate('user-a');assert.equal(outbox.pending,0);
 const initial=()=>({settings:{track:'eaqe',examDate:''},entitlement:{plan:'free'},attempts:[],reviews:{},usage:{},session:null});const state=cloudSnapshotToState({entitlement:{plan:'full'},attempts:[]},initial);assert.equal(state.entitlement.plan,'free');
});
test('post-login destinations cannot redirect to external or privileged routes',()=>{
 assert.equal(safeReturnRoute('quiz'),'quiz');assert.equal(safeReturnRoute('part/8'),'part/8');for(const value of ['https://evil.test','//evil.test','admin','javascript:alert(1)','part/9'])assert.equal(safeReturnRoute(value),'account');
});
test('replaying acknowledged attempts does not duplicate history or invent a local score',()=>{
 const state={attempts:[],reviews:{},settings:{},usage:{}};const attempt={id:'attempt-a',questionId:'q1',questionVersion:1,optionId:'option-c',part:1,at:'2026-10-04T16:30:00Z',day:'2026-10-05',correct:false,uncertain:false};const response={attempt,review:{status:'wrong',due:'2026-10-06',successes:0}};applyCloudAttempt(state,response);applySyncEvent(state,{kind:'attempt',payload:response});assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].correct,false);assert.equal(state.attempts[0].day,'2026-10-05');assert.equal(state.reviews.q1.status,'wrong');
 applySyncEvent(state,{kind:'review',payload:{questionId:'q1',attemptId:'attempt-a',review:{status:'completed',successes:2}}});assert.equal(state.attempts[0].uncertain,false);assert.equal(state.attempts[0].postUncertain,true);assert.equal(state.reviews.q1.status,'completed');
});
test('session restore without a review field retains prior authoritative review state',()=>{
 const state={attempts:[],reviews:{q1:{status:'wrong'}},settings:{},usage:{}};applyCloudAttempt(state,{attempt:{id:'attempt-a',questionId:'q1',part:1,at:'2026-10-04T10:00:00Z',day:'2026-10-04',correct:false}});assert.equal(state.reviews.q1.status,'wrong');
});
test('two tabs sharing Web Locks retain every queued event and do not submit acknowledged events twice',async()=>{
 const pending=new Map(),data=storage(),sent=[];const locks={request(key,operation){const previous=pending.get(key)||Promise.resolve();const result=previous.then(operation);pending.set(key,result.catch(()=>{}));return result;}};const api={request:async(_path,{body})=>{sent.push(body.eventId);return {accepted:true};}};
 const a=new AccountOutbox({storage:data,api,locks}),b=new AccountOutbox({storage:data,api,locks});a.activate('user-a');b.activate('user-a');await Promise.all(Array.from({length:20},(_,i)=>(i%2?a:b).enqueueDurably('attempt',{eventId:`event-${i}`,question_id:'q1'})));await Promise.all([a.flushLocked({}),b.flushLocked({})]);assert.equal(new Set(sent).size,20);assert.equal(sent.length,20);assert.deepEqual(JSON.parse(data.getItem(a.key)),[]);
});

test('account switch during asynchronous acknowledgement never persists old events into the new account',async()=>{
 const data=storage();let release,entered;const waiting=new Promise(resolve=>release=resolve),ackStarted=new Promise(resolve=>entered=resolve);const outbox=new AccountOutbox({storage:data,api:{request:async()=>({accepted:true})},uuid:()=> 'event-a'});outbox.activate('user-a');outbox.enqueue('attempt',{question_id:'q1'});const originalKey=outbox.key;const flush=outbox.flush({onAck:async()=>{entered();await waiting;}});await ackStarted;outbox.deactivate();outbox.activate('user-b');outbox.enqueue('usage',{eventId:'event-b'});release();await flush;assert.deepEqual(outbox.events.map(e=>e.id),['event-b']);assert.deepEqual(JSON.parse(data.getItem(outbox.key)).map(e=>e.id),['event-b']);assert.deepEqual(JSON.parse(data.getItem(originalKey)).map(e=>e.id),['event-a']);
});
