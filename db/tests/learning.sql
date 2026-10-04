-- Transactional isolation and RPC tests. All questions and identities are synthetic.
\set ON_ERROR_STOP on
begin;
create function pg_temp.assert_true(p_ok boolean,p_label text) returns void language plpgsql as $$
begin if not coalesce(p_ok,false) then raise exception 'TEST_FAILED: %',p_label; end if; end $$;
create function pg_temp.expect_error(p_sql text,p_code text) returns void language plpgsql as $$
declare caught boolean := false;
begin
  begin execute p_sql;
  exception when others then
    if sqlstate=p_code or sqlerrm=p_code then caught := true; else raise; end if;
  end;
  if not caught then raise exception 'TEST_FAILED: expected % for %',p_code,p_sql; end if;
end $$;

insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
 ('11111111-1111-4111-8111-111111111111','one@example.invalid',now(),false),
 ('22222222-2222-4222-8222-222222222222','two@example.invalid',now(),false),
 ('33333333-3333-4333-8333-333333333333','unverified@example.invalid',null,false),
 ('44444444-4444-4444-8444-444444444444','anonymous@example.invalid',now(),true);
insert into auth.sessions(id,user_id) select id,id from auth.users;
insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,part,tracks,is_free,rights_status,review_status,published,verified_at)
select id,1,'Synthetic database question '||id,
 '[{"id":"opt-one","text":"One"},{"id":"opt-two","text":"Two"},{"id":"opt-three","text":"Three"},{"id":"opt-four","text":"Four"},{"id":"opt-five","text":"Five"}]'::jsonb,
 'opt-one','{"core":"Synthetic concept","apply":"Synthetic application","options":{"opt-one":"Correct synthetic choice","opt-two":"Wrong synthetic choice","opt-three":"Wrong synthetic choice","opt-four":"Wrong synthetic choice","opt-five":"Wrong synthetic choice"},"memory":"Synthetic memory aid"}'::jsonb,
 1,array['eaqe','sqe'],is_free,'approved','approved',true,now()
from (values ('test-free-1',true),('test-free-2',true),('test-paid',false)) x(id,is_free);
insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,part,tracks,is_free)
values('test-draft',1,'Unapproved synthetic draft','[{"id":"a","text":"A"},{"id":"b","text":"B"}]','a','{}',1,array['eaqe'],true);

-- RLS is present on every private table; no direct grants to client roles, no helper access.
select pg_temp.assert_true(not exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r' and not c.relrowsecurity),'Every private table has RLS');
select pg_temp.assert_true(not has_schema_privilege('authenticated','app_private','USAGE'),'Private schema is not client-readable');
select pg_temp.assert_true(not has_table_privilege('authenticated','app_private.attempts','INSERT,UPDATE,DELETE'),'Scores cannot be overwritten');
select pg_temp.assert_true(not has_table_privilege('authenticated','app_private.access_grants','INSERT,UPDATE,DELETE'),'Entitlements cannot be changed');
select pg_temp.assert_true(not has_function_privilege('authenticated','app_private.lock_user()','EXECUTE'),'No helper RPC bypass');
select pg_temp.assert_true(not has_function_privilege('anon','public.app_get_account()','EXECUTE'),'Anonymous role has no account RPC');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.app_rate_limit(text,integer,integer)','EXECUTE'),'Users cannot reset rate limits');
select pg_temp.assert_true(not has_function_privilege('authenticated','public.app_prepare_delete(uuid)','EXECUTE'),'Users cannot bypass backend password reauthentication to suspend accounts');
select pg_temp.assert_true(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app_private') and p.proname like 'app_%' and p.prosecdef and not coalesce(p.proconfig @> array['search_path=""'],false)),'Definer functions have empty search_path');
select pg_temp.expect_error($$insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,part,tracks,published) values('illegal',1,'Illegal','[{"id":"a","text":"A"},{"id":"a","text":"Duplicate"}]','a','{}',1,array['eaqe'],true)$$,'APP_INVALID');
select pg_temp.expect_error($$update app_private.question_versions set published=true where question_id='test-draft'$$,'APP_INVALID');

set local role anon;
select pg_temp.expect_error('select public.app_get_account()','42501');
select pg_temp.expect_error('select * from app_private.question_versions','42501');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub','',true);
select pg_temp.expect_error('select public.app_get_account()','APP_UNAUTHENTICATED');
select set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',true);
select pg_temp.expect_error('select public.app_get_account()','APP_UNVERIFIED');
select set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',true);
select pg_temp.expect_error('select public.app_get_account()','APP_UNVERIFIED');
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select set_config('request.jwt.claims','{}',true);
select pg_temp.expect_error('select public.app_get_account()','APP_UNAUTHENTICATED');
select set_config('request.jwt.claims','{"session_id":"22222222-2222-4222-8222-222222222222"}',true);
select pg_temp.expect_error('select public.app_get_account()','APP_UNAUTHENTICATED');
select set_config('request.jwt.claims','',true);
reset role;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where user_id='11111111-1111-4111-8111-111111111111';
set local role authenticated;
select pg_temp.expect_error('select public.app_get_account()','APP_UNAUTHENTICATED');
reset role;
update auth.sessions set not_after=null where user_id='11111111-1111-4111-8111-111111111111';
delete from auth.sessions where user_id='11111111-1111-4111-8111-111111111111';
set local role authenticated;
select pg_temp.expect_error('select public.app_get_account()','APP_UNAUTHENTICATED');
reset role;
insert into auth.sessions(id,user_id) values('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111');
update auth.users set banned_until=clock_timestamp()+interval '1 day' where id='11111111-1111-4111-8111-111111111111';
set local role authenticated;
select pg_temp.expect_error('select public.app_get_account()','APP_FORBIDDEN');
reset role;
update auth.users set banned_until=null where id='11111111-1111-4111-8111-111111111111';
set local role authenticated;
select public.app_get_account() as account \gset
select pg_temp.assert_true(:'account'::jsonb->'profile'->>'id'='11111111-1111-4111-8111-111111111111','Identity comes from auth.uid');
select pg_temp.assert_true((:'account'::jsonb->'catalog'->0->>'available')::integer=2,'Paid and unapproved content not available');
select public.app_save_settings(1,'{"track":"sqe","examDate":"2026-12-01"}') as saved \gset
select pg_temp.assert_true((:'saved'::jsonb->>'version')::integer=2,'Settings CAS increments');
select pg_temp.expect_error($$select public.app_save_settings(1,'{"track":"eaqe","examDate":""}')$$,'APP_CONFLICT');
select pg_temp.expect_error($$select public.app_save_settings(2,'{"track":"eaqe","examDate":"2026-02-30"}')$$,'APP_INVALID');
select pg_temp.expect_error($$select public.app_save_settings(2,'{"track":"eaqe","examDate":"","paid":true}')$$,'APP_INVALID');
select pg_temp.expect_error($$select public.app_create_session('{"eventId":"10000000-0000-4000-8000-000000000011","track":"eaqe","mode":"practice","questionIds":["test-paid"]}')$$,'APP_NOT_FOUND');
select pg_temp.expect_error($$select public.app_create_session('{"eventId":"10000000-0000-4000-8000-000000000012","track":"eaqe","mode":"practice","questionIds":["test-draft"]}')$$,'APP_NOT_FOUND');
select public.app_create_session('{"eventId":"10000000-0000-4000-8000-000000000001","track":"eaqe","mode":"practice","questionIds":["test-free-1","test-free-2"]}') as created \gset
select pg_temp.assert_true(not (:'created'::jsonb)::text like '%answerOptionId%' and not (:'created'::jsonb)::text like '%Synthetic concept%','No pre-answer answer/explanation leakage');
select pg_temp.assert_true(jsonb_array_length(:'created'::jsonb->'session'->'items')=2,'Creates complete requested sample');
select public.app_create_session('{"eventId":"10000000-0000-4000-8000-000000000001","track":"eaqe","mode":"practice","questionIds":["test-free-1","test-free-2"]}') as created_again \gset
select pg_temp.assert_true(:'created'::jsonb->'session' = :'created_again'::jsonb->'session','Retry preserves question and option order');
select pg_temp.expect_error($$select public.app_create_session('{"eventId":"10000000-0000-4000-8000-000000000001","track":"sqe","mode":"practice","questionIds":["test-free-1","test-free-2"]}')$$,'APP_CONFLICT');
select :'created'::jsonb->>'sessionId' as session_id, :'created'::jsonb->'session'->'items'->0->>'id' as first_question \gset
select jsonb_build_object('eventId','20000000-0000-4000-8000-000000000001','sessionId',:'session_id','sessionVersion',1,'questionId',:'first_question','questionVersion',1,'optionId','opt-two','uncertain',false,'seconds',12,'clientOccurredAt',(now()-interval '2 days')) as wrong_request \gset
select public.app_submit_attempt(:'wrong_request'::jsonb) as wrong_result \gset
select pg_temp.assert_true((:'wrong_result'::jsonb->'attempt'->>'correct')::boolean=false,'Server grades wrong stable option ID');
select pg_temp.assert_true((:'wrong_result'::jsonb->'attempt'->>'delayed')::boolean=true,'Old client timestamp marks delayed');
select pg_temp.assert_true(:'wrong_result'::jsonb->'attempt'->>'day'=((clock_timestamp() at time zone 'Asia/Hong_Kong')::date)::text,'Review uses acceptance HK date, never client date');
select pg_temp.assert_true(:'wrong_result'::jsonb->'review'->>'status'='wrong','Wrong answer and review saved together');
select pg_temp.assert_true(:'wrong_result'::jsonb->'explanation'->>'answerOptionId'='opt-one','Explanation only after grading');
select public.app_submit_attempt(:'wrong_request'::jsonb) as wrong_retry \gset
select pg_temp.assert_true(:'wrong_result'::jsonb=:'wrong_retry'::jsonb,'Identical retry returns original result');
select pg_temp.expect_error(format('select public.app_submit_attempt(%L::jsonb)',(:'wrong_request'::jsonb || '{"optionId":"opt-one"}')::text),'APP_CONFLICT');
select pg_temp.expect_error(format('select public.app_submit_attempt(%L::jsonb)',(:'wrong_request'::jsonb || '{"eventId":"20000000-0000-4000-8000-000000000002","sessionVersion":2}')::text),'APP_CONFLICT');
select pg_temp.expect_error(format('select public.app_submit_attempt(%L::jsonb)',(:'wrong_request'::jsonb || '{"correct":true}')::text),'APP_INVALID');
select public.app_get_session(:'session_id'::uuid) as resumed \gset
select pg_temp.assert_true(:'resumed'::jsonb->'session'->'result'->>'id'='20000000-0000-4000-8000-000000000001','Resume shows submitted result without double grading');
select public.app_advance_session(:'session_id'::uuid,2) as advanced \gset
select pg_temp.assert_true((:'advanced'::jsonb->'session'->>'index')::integer=1 and not (:'advanced'::jsonb->'session') ? 'result','Next question hides previous result');
select pg_temp.expect_error(format('select public.app_advance_session(%L::uuid,2)',:'session_id'),'APP_CONFLICT');

-- The other verified account cannot see A's session, attempt, settings or events.
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select public.app_get_account() as other_account \gset
select pg_temp.assert_true(:'other_account'::jsonb->'settings'->>'track'='eaqe','Other account receives independent settings');
select pg_temp.expect_error(format('select public.app_get_session(%L::uuid)',:'session_id'),'APP_NOT_FOUND');
select pg_temp.expect_error($$select public.app_mark_uncertain('{"eventId":"30000000-0000-4000-8000-000000000001","attemptId":"20000000-0000-4000-8000-000000000001"}')$$,'APP_NOT_FOUND');
select pg_temp.assert_true(jsonb_array_length(public.app_sync()->'events')=0,'Other account receives no events');
select pg_temp.expect_error('update app_private.attempts set correct=true','42501');
select pg_temp.expect_error('insert into app_private.access_grants default values','42501');
select public.app_create_session('{"eventId":"60000000-0000-4000-8000-000000000001","track":"eaqe","mode":"practice","questionIds":["test-free-1"]}') as atomic_session \gset
reset role;
create function pg_temp.reject_test_event() returns trigger language plpgsql as $$
begin
  if new.user_id='22222222-2222-4222-8222-222222222222' and new.kind='attempt' then raise exception 'APP_TEST_ROLLBACK'; end if;
  return new;
end $$;
create trigger synthetic_reject_event before insert on app_private.user_events for each row execute function pg_temp.reject_test_event();
set local role authenticated;
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.expect_error(format('select public.app_submit_attempt(%L::jsonb)',jsonb_build_object('eventId','61000000-0000-4000-8000-000000000001','sessionId',:'atomic_session'::jsonb->>'sessionId','sessionVersion',1,'questionId','test-free-1','questionVersion',1,'optionId','opt-two','uncertain',false)::text),'APP_TEST_ROLLBACK');
reset role;
select pg_temp.assert_true(not exists(select 1 from app_private.attempts where user_id='22222222-2222-4222-8222-222222222222'),'Later transaction failure rolls back inserted attempt');
select pg_temp.assert_true(not exists(select 1 from app_private.review_state where user_id='22222222-2222-4222-8222-222222222222'),'Later transaction failure rolls back review state');
select pg_temp.assert_true((select version=1 from app_private.practice_sessions where id=(:'atomic_session'::jsonb->>'sessionId')::uuid),'Later transaction failure rolls back session CAS');
drop trigger synthetic_reject_event on app_private.user_events;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.app_mark_uncertain('{"eventId":"30000000-0000-4000-8000-000000000001","attemptId":"20000000-0000-4000-8000-000000000001"}') as marked \gset
select pg_temp.assert_true(:'marked'::jsonb->'review'->>'status'='uncertain','Post-answer uncertainty creates independent event');
select public.app_sync('0',2) as page1 \gset
select pg_temp.assert_true(jsonb_array_length(:'page1'::jsonb->'events')=2 and (:'page1'::jsonb->>'hasMore')::boolean,'Incremental sync obeys limit');
select public.app_sync(:'page1'::jsonb->>'cursor',100) as page2 \gset
select pg_temp.assert_true(jsonb_array_length(:'page2'::jsonb->'events')=3 and not (:'page2'::jsonb->>'hasMore')::boolean,'Second sync page has all remaining committed changes');
select pg_temp.assert_true(not (:'page2'::jsonb)::text like '%Synthetic concept%' and not (:'page2'::jsonb)::text like '%answerOptionId%','Sync contains no protected explanations');
select pg_temp.expect_error('select public.app_sync(''999999'',10)','APP_CONFLICT');
select pg_temp.expect_error('select public.app_sync(''0'',101)','APP_INVALID');

-- UTC storage, two distinct HK review days, same-day duplicate successes and failures reset.
reset role;
select app_private.apply_review('11111111-1111-4111-8111-111111111111',:'first_question',false,false,'2026-10-01T15:59:00Z');
select app_private.apply_review('11111111-1111-4111-8111-111111111111',:'first_question',true,false,'2026-10-01T16:01:00Z');
select pg_temp.assert_true((select successes=1 and last_success_day='2026-10-02' from app_private.review_state where user_id='11111111-1111-4111-8111-111111111111' and question_id=:'first_question'),'Hong Kong midnight starts next date');
select app_private.apply_review('11111111-1111-4111-8111-111111111111',:'first_question',true,false,'2026-10-02T08:00:00Z');
select pg_temp.assert_true((select successes=1 from app_private.review_state where user_id='11111111-1111-4111-8111-111111111111' and question_id=:'first_question'),'Same HK day does not increase success');
select app_private.apply_review('11111111-1111-4111-8111-111111111111',:'first_question',true,false,'2026-10-02T16:00:00Z');
select pg_temp.assert_true((select status='completed' and successes=2 and due is null from app_private.review_state where user_id='11111111-1111-4111-8111-111111111111' and question_id=:'first_question'),'Two HK dates complete review');
select app_private.apply_review('11111111-1111-4111-8111-111111111111',:'first_question',true,true,'2026-10-03T08:00:00Z');
select pg_temp.assert_true((select status='uncertain' and successes=0 and due='2026-10-04' from app_private.review_state where user_id='11111111-1111-4111-8111-111111111111' and question_id=:'first_question'),'Uncertainty after completion reopens review');
select pg_temp.assert_true((select count(*)=1 from app_private.attempts where user_id='11111111-1111-4111-8111-111111111111'),'Retries do not duplicate historical attempts');
select pg_temp.expect_error($$update app_private.question_versions set answer_option_id='opt-two' where question_id='test-free-1' or question_id='test-free-2'$$,'APP_IMMUTABLE_VERSION');

-- Union overlapping usage across devices instead of summing raw intervals.
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select jsonb_build_object('eventId','40000000-0000-4000-8000-000000000001','deviceId','device-a','segments',jsonb_build_array(
  jsonb_build_object('id','41000000-0000-4000-8000-000000000001','startAt',now()-interval '10 minutes','endAt',now()-interval '5 minutes','kind','foreground'),
  jsonb_build_object('id','41000000-0000-4000-8000-000000000002','startAt',now()-interval '10 minutes','endAt',now()-interval '8 minutes','kind','effective'))) as usage_request \gset
select public.app_add_usage(:'usage_request'::jsonb) as usage1 \gset
select public.app_add_usage(:'usage_request'::jsonb) as usage_retry \gset
select pg_temp.assert_true(:'usage1'::jsonb=:'usage_retry'::jsonb,'Usage event idempotency');
select jsonb_build_object('eventId','40000000-0000-4000-8000-000000000002','deviceId','device-b','segments',jsonb_build_array(
  jsonb_build_object('id','41000000-0000-4000-8000-000000000003','startAt',now()-interval '7 minutes','endAt',now()-interval '2 minutes','kind','foreground'))) as usage_request2 \gset
select public.app_add_usage(:'usage_request2'::jsonb) as usage2 \gset
select pg_temp.assert_true((:'usage2'::jsonb->'totals'->>'foregroundSeconds')::numeric=480 and (:'usage2'::jsonb->'totals'->>'effectiveSeconds')::numeric=120,'Overlapping foreground intervals union to eight minutes');
select pg_temp.expect_error(format('select public.app_add_usage(%L::jsonb)',(:'usage_request'::jsonb || '{"deviceId":"changed"}')::text),'APP_CONFLICT');
select pg_temp.expect_error(format('select public.app_add_usage(%L::jsonb)',jsonb_build_object('eventId','40000000-0000-4000-8000-000000000004','deviceId','a','segments',jsonb_build_array(jsonb_build_object('id','41000000-0000-4000-8000-000000000004','startAt',now()-interval '1 minute','endAt',now(),'kind','effective')))::text),'APP_INVALID');
select public.app_export() as exported \gset
select pg_temp.assert_true(not (:'exported'::jsonb)::text like '%answerOptionId%' and not (:'exported'::jsonb)::text like '%Synthetic database question%','Export excludes question content and answers');
select pg_temp.assert_true(jsonb_array_length(:'exported'::jsonb->'attempts')=1,'Export retains historical attempt');
select pg_temp.assert_true((select sum((value->>'foregroundSeconds')::numeric) from jsonb_each(:'exported'::jsonb->'dailyUsage'))=480,'Daily HK usage equals overall union');
select pg_temp.expect_error('select public.app_rate_limit(repeat(''a'',64),2,60)','42501');
select pg_temp.expect_error('select public.app_register_recovery(repeat(''b'',64),auth.uid(),now()+interval ''5 minutes'')','42501');
select pg_temp.expect_error('select public.app_consume_recovery(repeat(''b'',64),auth.uid())','42501');
reset role;
set local role service_role;
select public.app_rate_limit(repeat('a',64),2,86400) as limit1 \gset
select public.app_rate_limit(repeat('a',64),2,86400) as limit2 \gset
select public.app_rate_limit(repeat('a',64),2,86400) as limit3 \gset
select pg_temp.assert_true((:'limit1'::jsonb->>'allowed')::boolean and (:'limit2'::jsonb->>'allowed')::boolean and not (:'limit3'::jsonb->>'allowed')::boolean,'Shared rate limit denies third request');
select pg_temp.expect_error('select public.app_rate_limit(''raw-email@example.invalid'',2,60)','APP_INVALID');
select pg_temp.assert_true((public.app_register_recovery(repeat('b',64),'11111111-1111-4111-8111-111111111111',now()+interval '5 minutes')->>'registered')::boolean,'Service can register verified recovery proof');
select pg_temp.expect_error('select public.app_consume_recovery(repeat(''b'',64),''22222222-2222-4222-8222-222222222222'')','APP_UNAUTHENTICATED');
select pg_temp.assert_true((public.app_consume_recovery(repeat('b',64),'11111111-1111-4111-8111-111111111111')->>'consumed')::boolean,'Recovery nonce consumed exactly once');
select pg_temp.expect_error('select public.app_consume_recovery(repeat(''b'',64),''11111111-1111-4111-8111-111111111111'')','APP_UNAUTHENTICATED');
select pg_temp.expect_error('select public.app_register_recovery(repeat(''c'',64),''11111111-1111-4111-8111-111111111111'',now()+interval ''11 minutes'')','APP_INVALID');
select pg_temp.expect_error('select public.app_register_recovery(repeat(''c'',64),''33333333-3333-4333-8333-333333333333'',now()+interval ''5 minutes'')','APP_UNAUTHENTICATED');
select public.app_register_recovery(repeat('d',64),'11111111-1111-4111-8111-111111111111',now()+interval '5 minutes');
update app_private.recovery_intents set expires_at=now()-interval '1 second' where nonce_hash=repeat('d',64);
select pg_temp.expect_error('select public.app_consume_recovery(repeat(''d'',64),''11111111-1111-4111-8111-111111111111'')','APP_UNAUTHENTICATED');
reset role;

-- Split at HK midnight before union; this one two-minute interval contributes one minute to each date.
insert into app_private.usage_segments(user_id,segment_id,device_id,kind,starts_at,ends_at,accepted_at)
select '11111111-1111-4111-8111-111111111111','71000000-0000-4000-8000-000000000001','midnight','foreground',
  (((now() at time zone 'Asia/Hong_Kong')::date-1)::timestamp at time zone 'Asia/Hong_Kong')-interval '1 minute',
  (((now() at time zone 'Asia/Hong_Kong')::date-1)::timestamp at time zone 'Asia/Hong_Kong')+interval '1 minute',now();
select pg_temp.assert_true((app_private.daily_usage('11111111-1111-4111-8111-111111111111')->(((now() at time zone 'Asia/Hong_Kong')::date-2)::text)->>'foregroundSeconds')::numeric=60,'HK midnight interval first date');
select pg_temp.assert_true((app_private.daily_usage('11111111-1111-4111-8111-111111111111')->(((now() at time zone 'Asia/Hong_Kong')::date-1)::text)->>'foregroundSeconds')::numeric=60,'HK midnight interval second date');

-- Server-only grants enable paid content temporarily; expiration is checked on submit/resume.
insert into app_private.access_grants(user_id,source_reference,tracks,starts_at,expires_at) values('11111111-1111-4111-8111-111111111111','synthetic-no-payment',array['eaqe'],now()-interval '1 day',now()+interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select public.app_create_session('{"eventId":"50000000-0000-4000-8000-000000000001","track":"eaqe","mode":"practice","questionIds":["test-paid"]}') as paid \gset
select pg_temp.expect_error('select public.app_prepare_delete(auth.uid())','42501');
reset role;
set local role service_role;
select pg_temp.expect_error('select public.app_prepare_delete(''11111111-1111-4111-8111-111111111111'')','APP_CONFLICT');
reset role;
update app_private.access_grants set expires_at=now()-interval '1 hour' where source_reference='synthetic-no-payment';
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select pg_temp.expect_error(format('select public.app_get_session(%L::uuid)',:'paid'::jsonb->>'sessionId'),'APP_FORBIDDEN');
select pg_temp.assert_true(jsonb_array_length(public.app_sync()->'events')>0,'Expired access still permits personal history summary');
select set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',true);
select pg_temp.expect_error('select public.app_prepare_delete(auth.uid())','42501');
reset role;
set local role anon;
select pg_temp.expect_error('select public.app_prepare_delete(''22222222-2222-4222-8222-222222222222'')','42501');
reset role;
set local role service_role;
select pg_temp.expect_error('select public.app_prepare_delete(''33333333-3333-4333-8333-333333333333'')','APP_UNAUTHENTICATED');
select public.app_prepare_delete('22222222-2222-4222-8222-222222222222') as deletion \gset
select pg_temp.assert_true((:'deletion'::jsonb->>'prepared')::boolean,'No-financial-record account can prepare deletion');
select pg_temp.assert_true((public.app_prepare_delete('22222222-2222-4222-8222-222222222222')->>'prepared')::boolean,'Deletion can safely retry after admin provider failure');
reset role;
set local role authenticated;
select pg_temp.expect_error('select public.app_get_account()','APP_FORBIDDEN');
reset role;
-- Force an exhausted user limit without 120 expensive fixture calls. A direct RPC must also deny.
insert into app_private.rate_limit_windows(key_hash,window_seconds,window_start,hits)
values(encode(sha256(convert_to('learning-user:11111111-1111-4111-8111-111111111111','UTF8')),'hex'),60,
  to_timestamp((floor(extract(epoch from clock_timestamp())/60)+1)*60),120)
on conflict(key_hash,window_seconds) do update set window_start=excluded.window_start,hits=excluded.hits;
set local role authenticated;
select set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',true);
select pg_temp.expect_error('select public.app_get_account()','APP_RATE_LIMIT');
select pg_temp.expect_error($$select public.app_create_session('{"eventId":"80000000-0000-4000-8000-000000000001","track":"eaqe","mode":"practice","questionIds":["test-free-1"]}')$$,'APP_RATE_LIMIT');
select pg_temp.expect_error('select public.app_sync()','APP_RATE_LIMIT');
select pg_temp.expect_error('select public.app_export()','APP_RATE_LIMIT');
reset role;
delete from app_private.rate_limit_windows where key_hash=encode(sha256(convert_to('learning-user:11111111-1111-4111-8111-111111111111','UTF8')),'hex');
delete from auth.users where id='22222222-2222-4222-8222-222222222222';
select pg_temp.assert_true(not exists(select 1 from app_private.profiles where user_id='22222222-2222-4222-8222-222222222222'),'Auth deletion cascades to profile');
select pg_temp.assert_true(not exists(select 1 from app_private.user_settings where user_id='22222222-2222-4222-8222-222222222222'),'Auth deletion cascades to settings');

rollback;
\echo All synthetic SQL isolation, grading, idempotency, review, usage and entitlement checks passed.
