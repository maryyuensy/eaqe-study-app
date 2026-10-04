// Cookie 由伺服器管理；瀏覽器只保存按帳戶分隔的待同步事件。
const requestIdOf=value=>typeof value==='string'&&value.length===36&&/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(value)?value:undefined;
export class CloudError extends Error {
 constructor(code,message,status=0,requestId){super(message);this.name='CloudError';this.code=code;this.status=status;const safeId=requestIdOf(requestId);if(safeId)this.requestId=safeId;}
}
export function errorMessage(error,message=typeof error?.message==='string'&&error.message?error.message:'請求未完成，請稍後重試。'){const id=requestIdOf(error?.requestId);return id?`${message}（參考碼：${id}）`:message;}
export class ApiClient {
 constructor({fetcher=globalThis.fetch}={}){this.fetcher=fetcher;this.expectedAccountId=null;}
 async request(path,{method='GET',body,refresh=true}={}){
  if(!/^\/api\/[a-z0-9/-]+(?:\?[a-z0-9_=&.%+-]*)?$/i.test(path))throw new CloudError('invalid_path','請求路徑無效。');
  const verb=method.toUpperCase();const headers={Accept:'application/json'};
  if(this.expectedAccountId&&(path!=='/api/account'||verb!=='GET')&&(!path.startsWith('/api/auth/')||['/api/auth/logout','/api/auth/refresh'].includes(path)))headers['X-App-Account']=this.expectedAccountId;
  if(!['GET','HEAD'].includes(verb)){headers['X-App-Request']='1';headers['Content-Type']='application/json';}
  let response;const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);
  try{response=await this.fetcher(path,{method:verb,credentials:'same-origin',cache:'no-store',headers,signal:controller.signal,...(body!==undefined?{body:JSON.stringify(body)}:{})});}
  catch{throw new CloudError('network_error','網絡連線中斷，資料尚未同步。');}
  finally{clearTimeout(timeout);}
  if(response.status===401&&refresh&&!path.startsWith('/api/auth/')){
   await this.request('/api/auth/refresh',{method:'POST',body:{},refresh:false});
   return this.request(path,{method:verb,body,refresh:false});
  }
  const headerId=requestIdOf(response.headers?.get('x-request-id'));
  let data;try{data=response.status===204?null:await response.json();}catch{throw new CloudError('invalid_response','伺服器回覆無法讀取。',response.status,headerId);}
  if(!response.ok){const code=typeof data?.error?.code==='string'?data.error.code:'request_failed';const message=typeof data?.error?.message==='string'?data.error.message.slice(0,300):'請求未完成，請稍後重試。';const error=new CloudError(code,message,response.status,headerId||requestIdOf(data?.requestId)||requestIdOf(data?.error?.requestId));const retry=Number(response.headers?.get('retry-after'));if(Number.isFinite(retry)&&retry>0)error.retryAfter=Math.min(3600,retry)*1000;throw error;}
  return data;
 }
}
const PREFIX='propexam-cloud-v1:';
const ENDPOINTS={attempt:'/api/attempts',review:'/api/review-events',usage:'/api/usage'};
const jsonCopy=value=>JSON.parse(JSON.stringify(value));
const validId=value=>typeof value==='string'&&/^[a-zA-Z0-9-]{1,128}$/.test(value);
export class AccountOutbox {
 constructor({storage=globalThis.localStorage,api=new ApiClient(),now=()=>Date.now(),uuid=()=>crypto.randomUUID(),locks=globalThis.navigator?.locks}={}){this.storage=storage;this.api=api;this.now=now;this.uuid=uuid;this.locks=locks;this.userId=null;this.events=[];this.running=false;this.paused=false;this.lastError='';this.generation=0;}
 get key(){return this.userId?`${PREFIX}${this.userId}:outbox`:null;}
 get pending(){return this.events.length;}
 activate(userId){if(!validId(userId))throw new CloudError('invalid_account','帳戶資料無效。');this.generation++;this.userId=userId;this.running=false;this.paused=false;this.lastError='';let raw;try{raw=this.storage.getItem(this.key);}catch{throw new CloudError('storage_error','無法讀取待同步資料。');}let events=[];try{events=raw?JSON.parse(raw):[];}catch{throw new CloudError('storage_error','待同步資料損壞，請匯出後處理。');}if(!Array.isArray(events)||events.some(e=>!validId(e.id)||!ENDPOINTS[e.kind]||!e.payload||e.payload.eventId!==e.id||!Number.isInteger(e.tries)||e.tries<0))throw new CloudError('storage_error','待同步資料損壞，請匯出後處理。');this.events=events.map(e=>({...e,status:e.status==='sending'?'pending':e.status}));return this.events;}
 deactivate(){this.generation++;this.userId=null;this.events=[];this.running=false;this.paused=false;this.lastError='';}
 persist(events=this.events){if(!this.userId)throw new CloudError('unauthenticated','請先登入。',401);try{this.storage.setItem(this.key,JSON.stringify(events));}catch{throw new CloudError('storage_error','無法保存待同步資料；尚未提交至伺服器。');}this.events=events;}
 enqueue(kind,payload){if(!ENDPOINTS[kind])throw new CloudError('invalid_event','同步事件無效。');const id=payload.eventId||this.uuid();if(!validId(id))throw new CloudError('invalid_event','同步事件編號無效。');const clean=jsonCopy({...payload,eventId:id});const existing=this.events.find(e=>e.id===id);if(existing){if(existing.kind!==kind||JSON.stringify(existing.payload)!==JSON.stringify(clean))throw new CloudError('event_conflict','同一事件不可使用不同內容。');return existing;}const event={id,kind,payload:clean,status:'pending',tries:0,nextAt:0,error:''};this.persist([...this.events,event]);return event;}
 reload(){if(!this.userId)return;let events;try{events=JSON.parse(this.storage.getItem(this.key)||'[]');}catch{throw new CloudError('storage_error','待同步資料無法讀取。');}if(!Array.isArray(events)||events.some(e=>!validId(e.id)||!ENDPOINTS[e.kind]||e.payload?.eventId!==e.id))throw new CloudError('storage_error','待同步資料損壞，請先匯出。');this.events=events;}
 async exclusive(operation){return this.locks?.request?this.locks.request(this.key,operation):operation();}
 async enqueueDurably(kind,payload){const user=this.userId,generation=this.generation;return this.exclusive(()=>{if(this.userId!==user||this.generation!==generation)throw new CloudError('account_changed','帳戶已切換，未提交此答案。');this.reload();return this.enqueue(kind,payload);});}
 async flushLocked(options){const user=this.userId,generation=this.generation;return this.exclusive(async()=>{if(this.userId!==user||this.generation!==generation)return;this.reload();await this.flush(options);});}
 async flush({manual=false,onAck=()=>{},onChange=()=>{}}={}){
  if(!this.userId||this.running||this.paused&&!manual)return;const user=this.userId,generation=this.generation;this.running=true;if(manual){this.paused=false;this.persist(this.events.map(e=>e.terminal?e:{...e,tries:0,nextAt:0,status:'pending',error:''}));}onChange();
  try{for(const event of [...this.events]){if(this.userId!==user||this.generation!==generation)break;if(event.terminal||event.nextAt>this.now()||event.tries>=5)continue;const pending={...event,status:'sending',tries:event.tries+1};this.persist(this.events.map(e=>e.id===event.id?pending:e));onChange();try{const result=await this.api.request(ENDPOINTS[event.kind],{method:'POST',body:event.payload});if(this.userId!==user||this.generation!==generation)break;await onAck(event,result);if(this.userId!==user||this.generation!==generation)break;this.persist(this.events.filter(e=>e.id!==event.id));this.lastError=this.events.find(e=>e.status==='failed')?.error||'';}catch(error){if(this.userId!==user||this.generation!==generation)break;const status=error.status||0;const mismatch=error.code==='account_mismatch';const terminal=!mismatch&&[400,403,404,409,413,415,422].includes(status);const failed={...pending,status:'failed',terminal,error:errorMessage(error,error?.message||'同步未完成。'),nextAt:this.now()+Math.max(error.retryAfter||0,Math.min(60000,1000*2**pending.tries))};this.persist(this.events.map(e=>e.id===event.id?failed:e));this.lastError=failed.error;if(status===401||mismatch){this.paused=true;break;}if(!terminal)break;}onChange();}}
  finally{if(this.userId===user&&this.generation===generation){this.running=false;onChange();}}
 }
 export(){return jsonCopy({version:1,userId:this.userId,events:this.events});}
 clear(){if(!this.userId)return;try{this.storage.removeItem(this.key);}catch{throw new CloudError('storage_error','未能清除待同步資料。');}this.events=[];}
}
export function safeReturnRoute(value){return /^(home|learning|practice|analysis|history|concepts|quiz|summary|account|pricing|help|part\/[1-8])$/.test(value||'')?value:'account';}
export function cloudSnapshotToState(snapshot,initial){
 const next=initial();const data=snapshot?.state||snapshot||{};
 if(data.settings&&typeof data.settings==='object'){next.settings.track=['eaqe','sqe'].includes(data.settings.track)?data.settings.track:'eaqe';next.settings.examDate=typeof data.settings.examDate==='string'?data.settings.examDate:'';}
 if(Array.isArray(data.attempts))next.attempts=data.attempts.map(a=>({...a,id:a.id||a.client_event_id,questionId:a.questionId||a.question_id,questionVersion:a.questionVersion||a.question_version,part:a.part,selected:a.selected??a.choice_index,at:a.at||Date.parse(a.accepted_at||a.created_at),day:a.day||String(a.accepted_at||a.created_at||'').slice(0,10),seconds:a.seconds||0,mode:a.mode||'practice',correct:a.correct,uncertain:!!a.uncertain}));
 if(data.reviews&&typeof data.reviews==='object')next.reviews=jsonCopy(data.reviews);
 if(data.usage&&typeof data.usage==='object')next.usage=jsonCopy(data.usage);
 if(data.session)next.session=jsonCopy(data.session);
 if(data.lastSession)next.lastSession=jsonCopy(data.lastSession);
 return next;
}
export function normalizeCloudAttempt(attempt,session){
 const item=session?.items?.find(q=>q.id===attempt.questionId);
 const selected=item?item.options.findIndex(o=>o.id===attempt.optionId):attempt.selected;
 const at=typeof attempt.at==='number'?attempt.at:Date.parse(attempt.at);
 return {...attempt,part:attempt.part??item?.part,selected,at,day:attempt.day||new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at)),seconds:attempt.seconds||0};
}
export function applyCloudAttempt(state,response,session){
 const attempt=normalizeCloudAttempt(response.attempt,session);
 if(response.explanation)attempt.explanation=jsonCopy(response.explanation);
 const index=state.attempts.findIndex(a=>a.id===attempt.id);if(index<0)state.attempts.push(attempt);else{if(state.attempts[index].postUncertain)attempt.postUncertain=true;state.attempts[index]=attempt;}
 if(Object.hasOwn(response,'review')){if(response.review)state.reviews[attempt.questionId]=jsonCopy(response.review);else delete state.reviews[attempt.questionId];}
 return attempt;
}
export function applySyncEvent(state,event){
 const value=event.payload||{};
 if(event.kind==='attempt')applyCloudAttempt(state,value.attempt?value:{attempt:value,review:value.review},state.cloudSession);
 if(event.kind==='review'){
  const id=value.questionId||value.attempt?.questionId;if(id){if(value.review)state.reviews[id]=jsonCopy(value.review);else delete state.reviews[id];}
  if(value.attemptId){const attempt=state.attempts.find(a=>a.id===value.attemptId);if(attempt)attempt.postUncertain=true;}
 }
 if(event.kind==='settings'&&value.settings)state.settings={...state.settings,...value.settings};
 if(event.kind==='session'&&value.session)state.cloudSession=jsonCopy(value.session);
 if(event.kind==='usage'&&value.day){state.usage[value.day]=(value.totals?.effectiveSeconds??value.effectiveSeconds??0);}
 return state;
}
