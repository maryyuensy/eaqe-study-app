export const KEY='propexam-hk-v3';
export const REVIEW_SUCCESSES_REQUIRED=2;
export const dateKey=(time=Date.now())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
export const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
export const daysUntil=(day,now=Date.now())=>Math.round((Date.parse(day+'T00:00:00Z')-Date.parse(dateKey(now)+'T00:00:00Z'))/86400000);
export const initial=()=>({version:2,settings:{examDate:'',track:'eaqe'},entitlement:{plan:'free',expiresAt:null},attempts:[],reviews:{},usage:{},session:null,lastSession:null});
export function validate(s){if(!s||s.version!==2||!s.settings||!Array.isArray(s.attempts)||!s.reviews||!s.usage)throw Error('無法讀取已儲存的紀錄。');s.settings.track=['eaqe','sqe'].includes(s.settings.track)?s.settings.track:'eaqe';s.entitlement??={plan:'free',expiresAt:null};s.lastSession??=null;return s}
export const playable=q=>q.status==='ready'&&q.stem&&Array.isArray(q.options)&&q.options.length===5&&q.options.every(Boolean)&&Number.isInteger(q.answer)&&q.options[q.answer]&&q.explanation;
export const firstAttempts=s=>Array.from(s.attempts.reduce((m,a)=>{if(!m.has(a.questionId))m.set(a.questionId,a);return m},new Map()).values());
export const percent=attempts=>{const graded=attempts.filter(a=>a.correct!==null);return graded.length?Math.round(100*graded.filter(a=>a.correct).length/graded.length):null};
export function submitAnswer(s,q,choice,uncertain,now=Date.now()){
 const session=s.session;if(!session||session.ids[session.index]!==q.id||session.result)throw Error('此題已提交或練習已更改。');
 if(!Number.isInteger(choice)||!q.options[choice])throw Error('請先選擇答案。');
 const gradable=true;
 const a={id:`${session.id}:${session.index}`,questionId:q.id,questionVersion:q.version,part:q.part,selected:choice,correct:choice===q.answer,uncertain,at:now,day:dateKey(now),seconds:Math.round((session.activeMs||0)/1000),mode:session.mode,gradable};
 if(s.attempts.some(x=>x.id===a.id))return a;s.attempts.push(a);session.result=a;
 if(!gradable)return a;
 if(!a.correct||uncertain){s.reviews[q.id]={status:!a.correct?'wrong':'uncertain',due:addDays(a.day,1),lastAt:now,successes:0};}
 else if(s.reviews[q.id]){const old=s.reviews[q.id];const successes=(old.successes||0)+(old.lastSuccessDay===a.day?0:1);if(successes>=REVIEW_SUCCESSES_REQUIRED)delete s.reviews[q.id];else s.reviews[q.id]={...old,status:'consolidate',due:addDays(a.day,successes?3:1),lastAt:now,successes,lastSuccessDay:a.day};}
 return a;
}
export function randomSample(questions,count){const copy=[...questions];for(let i=copy.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[copy[i],copy[j]]=[copy[j],copy[i]]}return copy.slice(0,count)}
