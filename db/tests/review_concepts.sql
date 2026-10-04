-- Synthetic-only concept sync and question-version regression tests.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(p_ok boolean,p_label text) returns void language plpgsql as $$
begin if not coalesce(p_ok,false) then raise exception 'TEST_FAILED: %',p_label; end if; end $$;
create function pg_temp.expect_error(p_sql text,p_code text) returns void language plpgsql as $$
declare caught boolean := false;
begin
  begin execute p_sql;
  exception when others then if sqlstate=p_code or sqlerrm=p_code then caught:=true; else raise; end if; end;
  if not caught then raise exception 'TEST_FAILED: expected %',p_code; end if;
end $$;
insert into auth.users(id,email,email_confirmed_at) values
 ('77777777-7777-4777-8777-777777777777','concept-one@example.invalid',now()),
 ('88888888-8888-4888-8888-888888888888','concept-two@example.invalid',now());
insert into auth.sessions(id,user_id) select id,id from auth.users where email like 'concept-%@example.invalid';
insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,part,tracks,is_free,rights_status,review_status,published,verified_at)
select id,1,'Synthetic concept question '||id,'[{"id":"one","text":"Synthetic one"},{"id":"two","text":"Synthetic two"}]','one',
 '{"core":"Synthetic concept version one","apply":"Synthetic application one","options":{"one":"Correct synthetic choice","two":"Wrong synthetic choice"},"memory":"Synthetic aid one"}',
 1,tracks,is_free,'approved','approved',true,now()
from (values ('concept-a',true,array['eaqe','sqe']),('concept-b',true,array['eaqe']),
 ('concept-completed',true,array['eaqe','sqe']),('concept-paid',false,array['eaqe','sqe']),
 ('concept-sqe',true,array['sqe']),('concept-foreign',true,array['eaqe','sqe'])) x(id,is_free,tracks);
insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,part,tracks,is_free)
values('concept-draft',1,'Synthetic unapproved draft','[{"id":"one","text":"One"},{"id":"two","text":"Two"}]','one','{}',1,array['eaqe'],true);

select pg_temp.assert_true(not has_function_privilege('anon','public.app_get_review_concepts(text,text,integer)','EXECUTE'),'Anonymous concept RPC denied');
set local role anon;
select pg_temp.expect_error($$select public.app_get_review_concepts('eaqe')$$,'42501');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);
select public.app_create_session('{"eventId":"71000000-0000-4000-8000-000000000001","track":"eaqe","mode":"practice","questionIds":["concept-a"]}') as old_session \gset
select public.app_submit_attempt(jsonb_build_object('eventId','72000000-0000-4000-8000-000000000001','sessionId',:'old_session'::jsonb->>'sessionId','sessionVersion',1,'questionId','concept-a','questionVersion',1,'optionId','two','uncertain',false)) as wrong \gset
select pg_temp.assert_true(:'wrong'::jsonb->'review'->>'status'='wrong','Real wrong attempt produces pending review');
select public.app_create_session('{"eventId":"71000000-0000-4000-8000-000000000002","track":"eaqe","mode":"practice","questionIds":["concept-a"]}') as held_session \gset
select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',true);
select public.app_get_account();
reset role;
insert into app_private.review_state(user_id,question_id,status,successes,due,updated_at) values
 ('77777777-7777-4777-8777-777777777777','concept-b','uncertain',0,current_date+1,now()),
 ('77777777-7777-4777-8777-777777777777','concept-paid','wrong',0,current_date+1,now()),
 ('77777777-7777-4777-8777-777777777777','concept-sqe','wrong',0,current_date+1,now()),
 ('77777777-7777-4777-8777-777777777777','concept-draft','wrong',0,current_date+1,now()),
 ('77777777-7777-4777-8777-777777777777','concept-completed','completed',2,null,now()),
 ('88888888-8888-4888-8888-888888888888','concept-foreign','wrong',0,current_date+1,now());
insert into app_private.access_grants(user_id,source_reference,tracks,starts_at,expires_at)
values('77777777-7777-4777-8777-777777777777','synthetic-concept-grant',array['eaqe','sqe'],now()-interval '1 hour',now()+interval '1 day');
-- Keep the existing single-published-version invariant. Historical references
-- persist, but a withdrawn version must not continue serving protected content.
update app_private.question_versions set published=false where question_id='concept-a' and version=1;
insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,concept,part,tracks,is_free,rights_status,review_status,published,verified_at)
values('concept-a',2,'Synthetic corrected concept version','[{"id":"one","text":"Synthetic one"},{"id":"two","text":"Synthetic two"}]','two',
 '{"core":"Synthetic corrected core","apply":"Synthetic corrected application","options":{"one":"Wrong revised choice","two":"Correct revised choice"},"memory":"Synthetic corrected aid"}',
 'Synthetic classification',2,array['eaqe','sqe'],true,'approved','approved',true,now());
insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,part,tracks,is_free)
values('concept-a',3,'Synthetic future unpublished revision','[{"id":"one","text":"One"},{"id":"two","text":"Two"}]','one','{}',8,array['eaqe'],true);
set local role authenticated;
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);

select public.app_get_review_concepts('eaqe','',1) as first_page \gset
select pg_temp.assert_true(jsonb_array_length(:'first_page'::jsonb->'items')=1 and (:'first_page'::jsonb->>'hasMore')::boolean,'Stable bounded first concept page');
select pg_temp.assert_true(:'first_page'::jsonb->>'cursor'='concept-a','Cursor is last delivered ID');
select pg_temp.assert_true((:'first_page'::jsonb->'items'->0->>'questionVersion')::integer=2 and (:'first_page'::jsonb->'items'->0->>'part')::integer=2,'Latest approved version selected, newer draft ignored');
select pg_temp.assert_true(:'first_page'::jsonb->'items'->0->>'apply'='Synthetic corrected application','New device gets approved weak concept without loading old session');
select pg_temp.assert_true(not (:'first_page'::jsonb)::text like '%answer%' and not (:'first_page'::jsonb)::text like '%options%' and not (:'first_page'::jsonb)::text like '%stem%','Concept response has no answer options or stem');
select public.app_get_review_concepts('eaqe',:'first_page'::jsonb->>'cursor',50) as second_page \gset
select pg_temp.assert_true(jsonb_array_length(:'second_page'::jsonb->'items')=2 and not (:'second_page'::jsonb->>'hasMore')::boolean,'Remaining own accessible pending concepts returned without duplicates');
select pg_temp.assert_true((:'second_page'::jsonb)::text like '%concept-paid%' and not (:'second_page'::jsonb)::text like '%concept-completed%' and not (:'second_page'::jsonb)::text like '%concept-foreign%' and not (:'second_page'::jsonb)::text like '%concept-draft%' and not (:'second_page'::jsonb)::text like '%concept-sqe%','Own pending and approved track only');
select pg_temp.assert_true(:'second_page'::jsonb->'items'->0->>'concept'='Synthetic concept version one','Default classification falls back to core label');
select pg_temp.assert_true(jsonb_array_length(public.app_get_review_concepts('sqe')->'items')=3,'SQE concept track uses own authorized scope');
select pg_temp.expect_error($$select public.app_get_review_concepts('other')$$,'APP_INVALID');
select pg_temp.expect_error($$select public.app_get_review_concepts('eaqe','',51)$$,'APP_INVALID');
select pg_temp.expect_error($$select public.app_get_review_concepts('eaqe','invalid cursor',1)$$,'APP_INVALID');

select pg_temp.expect_error(format('select public.app_get_session(%L::uuid)',:'held_session'::jsonb->>'sessionId'),'APP_FORBIDDEN');
select pg_temp.expect_error(format('select public.app_submit_attempt(%L::jsonb)',jsonb_build_object('eventId','72000000-0000-4000-8000-000000000002','sessionId',:'held_session'::jsonb->>'sessionId','sessionVersion',1,'questionId','concept-a','questionVersion',1,'optionId','one','uncertain',false)::text),'APP_FORBIDDEN');
reset role;
select pg_temp.assert_true((select items->0->>'version'='1' from app_private.practice_sessions where id=(:'held_session'::jsonb->>'sessionId')::uuid),'Existing session retains old immutable reference');
select pg_temp.assert_true((select question_version=1 and correct=false and part=1 from app_private.attempts where id='72000000-0000-4000-8000-000000000001'),'Historical grade and version survive replacement without regrading');
set local role authenticated;
select public.app_create_session('{"eventId":"71000000-0000-4000-8000-000000000003","track":"eaqe","mode":"practice","questionIds":["concept-a","concept-b"]}') as latest_sample \gset
select pg_temp.assert_true(jsonb_array_length(:'latest_sample'::jsonb->'session'->'items')=2 and (select count(distinct item->>'id')=2 from jsonb_array_elements(:'latest_sample'::jsonb->'session'->'items') item),'New samples do not duplicate versioned questions');
select pg_temp.assert_true((select (item->>'version')::integer=2 from jsonb_array_elements(:'latest_sample'::jsonb->'session'->'items') item where item->>'id'='concept-a'),'New sessions select latest eligible version');
select public.app_create_session('{"eventId":"71000000-0000-4000-8000-000000000004","track":"eaqe","mode":"practice","questionIds":["concept-a"]}') as new_version_session \gset
select public.app_submit_attempt(jsonb_build_object('eventId','72000000-0000-4000-8000-000000000003','sessionId',:'new_version_session'::jsonb->>'sessionId','sessionVersion',1,'questionId','concept-a','questionVersion',2,'optionId','two','uncertain',false)) as new_correct \gset
select pg_temp.assert_true((:'new_correct'::jsonb->'attempt'->>'correct')::boolean and :'new_correct'::jsonb->'explanation'->>'answerOptionId'='two','New version grades its own corrected answer');
select public.app_get_account() as catalog \gset
select pg_temp.assert_true((select sum((item->>'total')::integer)=5 from jsonb_array_elements(:'catalog'::jsonb->'catalog') item where item->>'track'='eaqe'),'Catalog counts stable question IDs once');

reset role;
update app_private.access_grants set expires_at=clock_timestamp()-interval '1 second' where source_reference='synthetic-concept-grant';
set local role authenticated;
select pg_temp.assert_true(jsonb_array_length(public.app_get_review_concepts('eaqe')->'items')=2,'Expired paid access removes concept immediately');
select set_config('request.jwt.claim.sub','88888888-8888-4888-8888-888888888888',true);
select public.app_get_review_concepts('eaqe') as foreign_page \gset
select pg_temp.assert_true(jsonb_array_length(:'foreign_page'::jsonb->'items')=1 and :'foreign_page'::jsonb->'items'->0->>'questionId'='concept-foreign','Second account cannot read first account concepts');
select set_config('request.jwt.claim.sub','77777777-7777-4777-8777-777777777777',true);
reset role;
update app_private.review_state set status='completed',successes=2,due=null where user_id='77777777-7777-4777-8777-777777777777' and question_id='concept-a';
set local role authenticated;
select pg_temp.assert_true(jsonb_array_length(public.app_get_review_concepts('eaqe')->'items')=1,'Completed review stops exposing pending concept');
reset role;
update app_private.question_versions set published=false where question_id='concept-b';
set local role authenticated;
select pg_temp.assert_true(jsonb_array_length(public.app_get_review_concepts('eaqe')->'items')=0,'Withdrawn content does not fall back to retired versions');
select pg_temp.assert_true(public.app_get_review_concepts('eaqe','concept-z')->>'cursor'='concept-z','Empty final page preserves cursor');
rollback;
