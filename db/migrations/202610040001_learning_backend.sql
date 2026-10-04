-- Supabase / PostgreSQL 16. Apply once, in order, to an empty development project.
-- No textbook-derived question or personal history is included in this migration.
begin;

create schema app_private;
revoke all on schema app_private from public, anon, authenticated;
grant usage on schema app_private to service_role;
alter default privileges in schema app_private revoke all on tables from public, anon, authenticated;
alter default privileges in schema app_private revoke execute on functions from public, anon, authenticated;

create table app_private.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'suspended')),
  terms_version text,
  change_seq bigint not null default 0 check (change_seq >= 0),
  created_at timestamptz not null default now()
);
create table app_private.user_settings (
  user_id uuid primary key references app_private.profiles(user_id) on delete cascade,
  settings jsonb not null default '{"track":"eaqe","examDate":""}'::jsonb,
  version bigint not null default 1 check (version > 0),
  updated_at timestamptz not null default now()
);
create table app_private.question_versions (
  question_id text not null check (question_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$'),
  version integer not null check (version > 0),
  stem text not null check (length(btrim(stem)) between 1 and 10000),
  options jsonb not null,
  answer_option_id text not null,
  explanation jsonb not null,
  concept text not null default '未分類' check (length(btrim(concept)) between 1 and 200),
  part integer not null check (part between 1 and 8),
  tracks text[] not null check (cardinality(tracks) between 1 and 2 and tracks <@ array['eaqe','sqe']::text[]),
  is_free boolean not null default false,
  case_group_id text,
  case_stem text,
  case_order integer not null default 0 check (case_order >= 0),
  rights_status text not null default 'pending' check (rights_status in ('pending','approved','rejected')),
  review_status text not null default 'pending' check (review_status in ('pending','approved','rejected')),
  published boolean not null default false,
  verified_at timestamptz,
  sources jsonb not null default '[]'::jsonb check (jsonb_typeof(sources) = 'array'),
  created_at timestamptz not null default now(),
  primary key (question_id,version),
  check (not published or (rights_status = 'approved' and review_status = 'approved' and verified_at is not null)),
  check ((case_group_id is null and case_stem is null) or (length(case_group_id)>0 and length(case_stem)>0))
);
create unique index question_one_published_version on app_private.question_versions(question_id) where published;
create table app_private.access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_private.profiles(user_id) on delete cascade,
  source_reference text not null unique,
  tracks text[] not null check (cardinality(tracks) between 1 and 2 and tracks <@ array['eaqe','sqe']::text[]),
  starts_at timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (expires_at > starts_at)
);
create index grants_active_lookup on app_private.access_grants(user_id, expires_at) where revoked_at is null;
create table app_private.practice_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_private.profiles(user_id) on delete cascade,
  track text not null check (track in ('eaqe','sqe')),
  mode text not null check (mode in ('practice','review')),
  items jsonb not null check (jsonb_typeof(items)='array' and jsonb_array_length(items) between 1 and 50),
  current_index integer not null default 0 check (current_index >= 0),
  status text not null default 'active' check (status in ('active','completed')),
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id,id)
);
create index sessions_user_updated on app_private.practice_sessions(user_id, updated_at desc);
create table app_private.attempts (
  id uuid primary key,
  user_id uuid not null references app_private.profiles(user_id) on delete cascade,
  session_id uuid not null,
  ordinal integer not null check (ordinal >= 0),
  question_id text not null,
  question_version integer not null,
  part integer not null check (part between 1 and 8),
  concept text not null check (length(btrim(concept)) between 1 and 200),
  option_id text not null,
  correct boolean not null,
  uncertain boolean not null,
  seconds integer check (seconds between 0 and 10800),
  mode text not null check (mode in ('practice','review')),
  accepted_at timestamptz not null,
  hk_day date not null,
  client_occurred_at timestamptz,
  delayed boolean not null default false,
  foreign key (user_id,session_id) references app_private.practice_sessions(user_id,id) on delete cascade,
  foreign key (question_id,question_version) references app_private.question_versions(question_id,version),
  unique (user_id,id),
  unique (session_id,ordinal)
);
create index attempts_user_question on app_private.attempts(user_id,question_id,accepted_at,id);
create table app_private.review_state (
  user_id uuid not null references app_private.profiles(user_id) on delete cascade,
  question_id text not null,
  status text not null check (status in ('wrong','uncertain','consolidate','completed')),
  successes integer not null default 0 check (successes between 0 and 2),
  last_success_day date,
  due date,
  updated_at timestamptz not null,
  version bigint not null default 1,
  primary key(user_id,question_id),
  check ((status='completed' and successes=2 and due is null) or (status<>'completed' and successes<2 and due is not null))
);
create index review_due_lookup on app_private.review_state(user_id,due) where status<>'completed';
create table app_private.user_events (
  user_id uuid not null references app_private.profiles(user_id) on delete cascade,
  event_id uuid not null,
  seq bigint not null,
  kind text not null,
  request jsonb not null,
  payload jsonb not null,
  accepted_at timestamptz not null,
  primary key(user_id,event_id),
  unique(user_id,seq)
);
create table app_private.usage_segments (
  user_id uuid not null references app_private.profiles(user_id) on delete cascade,
  segment_id uuid not null,
  device_id text not null check (length(device_id) between 1 and 100),
  kind text not null check (kind in ('foreground','effective')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  accepted_at timestamptz not null,
  primary key(user_id,segment_id),
  check (ends_at > starts_at and ends_at-starts_at <= interval '30 minutes')
);
create index usage_user_window on app_private.usage_segments(user_id,kind,starts_at,ends_at);
create table app_private.reading_progress (
  user_id uuid not null references app_private.profiles(user_id) on delete cascade,
  unit_id text not null check (length(unit_id) between 1 and 100),
  completed_at timestamptz not null,
  primary key(user_id,unit_id)
);

-- The schema is not an exposed Data API schema. RLS is a second layer, not a replacement for grants.
do $$
declare t text;
begin
  foreach t in array array['profiles','user_settings','question_versions','access_grants','practice_sessions','attempts','review_state','user_events','usage_segments','reading_progress'] loop
    execute format('alter table app_private.%I enable row level security',t);
    execute format('revoke all on app_private.%I from public, anon, authenticated',t);
    execute format('grant all on app_private.%I to service_role',t);
  end loop;
end $$;
-- No authenticated direct writes: even one's own score, entitlement or review completion cannot be changed.
-- Definer RPCs below manually bind every query to auth.uid(); they never accept a user ID.

create function app_private.validate_question() returns trigger language plpgsql set search_path='' as $$
declare o jsonb; seen text[] := array[]::text[]; option_id text;
begin
  if jsonb_typeof(new.options)<>'array' or jsonb_array_length(new.options) not between 2 and 5 then raise exception 'APP_INVALID'; end if;
  for o in select value from jsonb_array_elements(new.options) loop
    if jsonb_typeof(o)<>'object' or not o ?& array['id','text'] or (o - array['id','text']) <> '{}'::jsonb or jsonb_typeof(o->'id')<>'string' or jsonb_typeof(o->'text')<>'string' then raise exception 'APP_INVALID'; end if;
    option_id := o->>'id';
    if length(option_id) not between 1 and 100 or length(btrim(o->>'text'))=0 or option_id=any(seen) then raise exception 'APP_INVALID'; end if;
    seen := array_append(seen,option_id);
  end loop;
  if not new.answer_option_id=any(seen) then raise exception 'APP_INVALID'; end if;
  if new.published then
    if jsonb_typeof(new.explanation)<>'object' or not new.explanation ?& array['core','apply','options','memory']
       or jsonb_typeof(new.explanation->'core')<>'string' or jsonb_typeof(new.explanation->'apply')<>'string' or jsonb_typeof(new.explanation->'memory')<>'string'
       or jsonb_typeof(new.explanation->'options')<>'object' or length(btrim(new.explanation->>'core'))=0
       or length(btrim(new.explanation->>'apply'))=0 or length(btrim(new.explanation->>'memory'))=0 then raise exception 'APP_INVALID'; end if;
    foreach option_id in array seen loop
      if not new.explanation->'options' ? option_id or jsonb_typeof(new.explanation->'options'->option_id)<>'string' or length(btrim(new.explanation->'options'->>option_id))=0 then raise exception 'APP_INVALID'; end if;
    end loop;
  end if;
  if tg_op='UPDATE' and (old.stem,old.options,old.answer_option_id,old.explanation,old.concept,old.part,old.tracks,old.case_group_id,old.case_stem,old.case_order) is distinct from (new.stem,new.options,new.answer_option_id,new.explanation,new.concept,new.part,new.tracks,new.case_group_id,new.case_stem,new.case_order)
     and exists (select 1 from app_private.attempts a where a.question_id=old.question_id and a.question_version=old.version) then
    raise exception 'APP_IMMUTABLE_VERSION';
  end if;
  return new;
end $$;
create trigger question_validate before insert or update on app_private.question_versions for each row execute function app_private.validate_question();

create function app_private.verified_user() returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid := auth.uid(); session_claim text := auth.jwt()->>'session_id';
begin
  if u is null then raise exception 'APP_UNAUTHENTICATED'; end if;
  if not exists (select 1 from auth.users au where au.id=u and au.email_confirmed_at is not null and not coalesce(au.is_anonymous,false)) then raise exception 'APP_UNVERIFIED'; end if;
  if exists(select 1 from auth.users au where au.id=u and au.banned_until>clock_timestamp()) then raise exception 'APP_FORBIDDEN'; end if;
  if session_claim is null or session_claim !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'APP_UNAUTHENTICATED'; end if;
  if not exists(select 1 from auth.sessions s where s.id=session_claim::uuid and s.user_id=u and (s.not_after is null or s.not_after>clock_timestamp())) then raise exception 'APP_UNAUTHENTICATED'; end if;
  return u;
end $$;
create function app_private.lock_user() returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.verified_user(); account_status text;
begin
  insert into app_private.profiles(user_id) values(u) on conflict do nothing;
  select p.status into account_status from app_private.profiles p where p.user_id=u for update;
  if account_status<>'active' then raise exception 'APP_FORBIDDEN'; end if;
  insert into app_private.user_settings(user_id) values(u) on conflict do nothing;
  return u;
end $$;
create function app_private.assert_object(p_request jsonb,p_keys text[],p_required text[]) returns void language plpgsql set search_path='' as $$
begin
  if p_request is null or jsonb_typeof(p_request)<>'object' or (p_request - p_keys)<>'{}'::jsonb or not p_request ?& p_required then raise exception 'APP_INVALID'; end if;
end $$;
create function app_private.valid_uuid(p_value text) returns uuid language plpgsql set search_path='' as $$
begin
  if p_value is null or p_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'APP_INVALID'; end if;
  return p_value::uuid;
end $$;
create function app_private.event_result(p_user uuid,p_event uuid,p_kind text,p_request jsonb) returns jsonb language plpgsql set search_path='' as $$
declare e app_private.user_events;
begin
  select * into e from app_private.user_events where user_id=p_user and event_id=p_event;
  if found then
    if e.kind<>p_kind or e.request<>p_request then raise exception 'APP_CONFLICT'; end if;
    return e.payload;
  end if;
  return null;
end $$;
create function app_private.record_event(p_user uuid,p_event uuid,p_kind text,p_request jsonb,p_payload jsonb,p_at timestamptz) returns jsonb language plpgsql set search_path='' as $$
declare n bigint; result jsonb;
begin
  update app_private.profiles set change_seq=change_seq+1 where user_id=p_user returning change_seq into n;
  result := p_payload || jsonb_build_object('cursor',n::text);
  insert into app_private.user_events(user_id,event_id,seq,kind,request,payload,accepted_at) values(p_user,p_event,n,p_kind,p_request,result,p_at);
  return result;
end $$;
create function app_private.can_access(p_user uuid,p_question app_private.question_versions,p_track text,p_at timestamptz) returns boolean language sql stable set search_path='' as $$
  select p_question.published and p_question.rights_status='approved' and p_question.review_status='approved' and p_track=any(p_question.tracks)
    and (p_question.is_free or exists(select 1 from app_private.access_grants g where g.user_id=p_user and p_track=any(g.tracks) and g.revoked_at is null and g.starts_at<=p_at and g.expires_at>p_at));
$$;
create function app_private.review_json(p_user uuid,p_question text) returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('questionId',r.question_id,'status',r.status,'due',r.due,'successes',r.successes,'lastSuccessDay',r.last_success_day,'version',r.version,'updatedAt',r.updated_at)
    from app_private.review_state r where r.user_id=p_user and r.question_id=p_question;
$$;
create function app_private.attempt_json(p_attempt app_private.attempts) returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('id',p_attempt.id,'sessionId',p_attempt.session_id,'questionId',p_attempt.question_id,'questionVersion',p_attempt.question_version,'part',p_attempt.part,'concept',p_attempt.concept,'optionId',p_attempt.option_id,'correct',p_attempt.correct,'uncertain',p_attempt.uncertain,'at',p_attempt.accepted_at,'day',p_attempt.hk_day,'seconds',p_attempt.seconds,'mode',p_attempt.mode,'delayed',p_attempt.delayed);
$$;
create function app_private.apply_review(p_user uuid,p_question text,p_correct boolean,p_uncertain boolean,p_at timestamptz) returns jsonb language plpgsql set search_path='' as $$
declare r app_private.review_state; today date := (p_at at time zone 'Asia/Hong_Kong')::date; new_successes integer;
begin
  select * into r from app_private.review_state where user_id=p_user and question_id=p_question;
  if not p_correct or p_uncertain then
    insert into app_private.review_state(user_id,question_id,status,successes,last_success_day,due,updated_at)
      values(p_user,p_question,case when not p_correct then 'wrong' else 'uncertain' end,0,null,today+1,p_at)
      on conflict(user_id,question_id) do update set status=excluded.status,successes=0,last_success_day=null,due=excluded.due,updated_at=excluded.updated_at,version=app_private.review_state.version+1;
  elsif found and r.status<>'completed' then
    new_successes := r.successes + case when r.last_success_day is distinct from today then 1 else 0 end;
    update app_private.review_state set successes=least(new_successes,2),last_success_day=today,
      status=case when new_successes>=2 then 'completed' else 'consolidate' end,
      due=case when new_successes>=2 then null else today+3 end,updated_at=p_at,version=version+1
      where user_id=p_user and question_id=p_question;
  end if;
  return app_private.review_json(p_user,p_question);
end $$;
create function app_private.session_json(p_user uuid,p_id uuid) returns jsonb language plpgsql set search_path='' as $$
declare s app_private.practice_sessions; ref jsonb; q app_private.question_versions; option jsonb; shown_options jsonb; shown jsonb := '[]'::jsonb; a app_private.attempts; result jsonb;
begin
  select * into s from app_private.practice_sessions where user_id=p_user and id=p_id;
  if not found then raise exception 'APP_NOT_FOUND'; end if;
  for ref in select value from jsonb_array_elements(s.items) loop
    select * into q from app_private.question_versions where question_id=ref->>'id' and version=(ref->>'version')::integer;
    if not found or not app_private.can_access(p_user,q,s.track,clock_timestamp()) then raise exception 'APP_FORBIDDEN'; end if;
    shown_options := '[]'::jsonb;
    for option in select value from jsonb_array_elements(ref->'optionIds') loop
      shown_options := shown_options || jsonb_build_array((select value from jsonb_array_elements(q.options) where value->>'id'=option#>>'{}'));
    end loop;
    shown := shown || jsonb_build_array(jsonb_build_object('id',q.question_id,'version',q.version,'stem',q.stem,'options',shown_options,'part',q.part,'concept',q.concept,'tracks',q.tracks,'isFree',q.is_free,'caseGroupId',q.case_group_id,'caseStem',q.case_stem));
  end loop;
  result := jsonb_build_object('id',s.id,'track',s.track,'mode',s.mode,'items',shown,'index',s.current_index,'status',s.status,'version',s.version,'createdAt',s.created_at);
  select * into a from app_private.attempts where user_id=p_user and session_id=s.id and ordinal=s.current_index;
  if found then
    select * into q from app_private.question_versions where question_id=a.question_id and version=a.question_version;
    result := result || jsonb_build_object('result',app_private.attempt_json(a),'explanation',jsonb_build_object('answerOptionId',q.answer_option_id,'content',q.explanation));
  end if;
  return result;
end $$;

create function public.app_get_account() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); result jsonb;
begin
  select jsonb_build_object('profile',jsonb_build_object('id',p.user_id,'status',p.status,'createdAt',p.created_at),
    'settings',s.settings,'version',s.version,'settingsVersion',s.version,'cursor',p.change_seq::text)
    into result from app_private.profiles p join app_private.user_settings s using(user_id) where p.user_id=u;
  return result;
end $$;
create function public.app_save_settings(p_expected_version bigint,p_settings jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); s app_private.user_settings; d text; result jsonb;
begin
  perform app_private.assert_object(p_settings,array['track','examDate'],array['track','examDate']);
  if p_settings->>'track' not in ('eaqe','sqe') or jsonb_typeof(p_settings->'track')<>'string' or jsonb_typeof(p_settings->'examDate')<>'string' then raise exception 'APP_INVALID'; end if;
  d := p_settings->>'examDate';
  if d<>'' then
    if d !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'APP_INVALID'; end if;
    begin if to_char(d::date,'YYYY-MM-DD')<>d then raise exception 'APP_INVALID'; end if;
    exception when datetime_field_overflow or invalid_datetime_format then raise exception 'APP_INVALID'; end;
  end if;
  select * into s from app_private.user_settings where user_id=u;
  if p_expected_version is null or s.version<>p_expected_version then raise exception 'APP_CONFLICT'; end if;
  update app_private.user_settings set settings=p_settings,version=version+1,updated_at=clock_timestamp() where user_id=u returning * into s;
  result := jsonb_build_object('settings',s.settings,'version',s.version,'settingsVersion',s.version);
  return app_private.record_event(u,gen_random_uuid(),'settings','{}',result,s.updated_at);
end $$;
create function public.app_create_session(p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); event_id uuid; old_result jsonb; s app_private.practice_sessions; q app_private.question_versions; track text; mode text; requested_ids text[]; n integer := 20; requested_part integer; items jsonb := '[]'::jsonb; option_ids jsonb; at_time timestamptz := clock_timestamp(); result jsonb;
begin
  perform app_private.assert_object(p_request,array['eventId','track','mode','questionIds','count','part'],array['eventId','track','mode']);
  event_id := app_private.valid_uuid(p_request->>'eventId'); track := p_request->>'track'; mode := p_request->>'mode';
  if track not in ('eaqe','sqe') or mode not in ('practice','review') or jsonb_typeof(p_request->'track')<>'string' or jsonb_typeof(p_request->'mode')<>'string' then raise exception 'APP_INVALID'; end if;
  old_result := app_private.event_result(u,event_id,'session',p_request);
  if old_result is not null then return old_result || jsonb_build_object('session',app_private.session_json(u,(old_result->>'sessionId')::uuid)); end if;
  if p_request ? 'count' then
    if jsonb_typeof(p_request->'count')<>'number' or (p_request->>'count') !~ '^([1-9]|[1-4][0-9]|50)$' then raise exception 'APP_INVALID'; end if;
    n := (p_request->>'count')::integer; if n not between 1 and 50 then raise exception 'APP_INVALID'; end if;
  end if;
  if p_request ? 'part' then
    if jsonb_typeof(p_request->'part')<>'number' or (p_request->>'part') !~ '^[1-8]$' then raise exception 'APP_INVALID'; end if;
    requested_part := (p_request->>'part')::integer;
  end if;
  if p_request ? 'questionIds' then
    if jsonb_typeof(p_request->'questionIds')<>'array' or jsonb_array_length(p_request->'questionIds') not between 1 and 50 or exists(select 1 from jsonb_array_elements(p_request->'questionIds') where jsonb_typeof(value)<>'string') then raise exception 'APP_INVALID'; end if;
    select array_agg(value) into requested_ids from jsonb_array_elements_text(p_request->'questionIds');
    if cardinality(requested_ids)<>(select count(distinct v) from unnest(requested_ids) v) then raise exception 'APP_INVALID'; end if;
    n := cardinality(requested_ids);
  end if;
  for q in
    with candidates as (
      select v.*,coalesce('case:'||v.case_group_id,'question:'||v.question_id) as group_key from app_private.question_versions v
      where app_private.can_access(u,v,track,at_time) and (requested_ids is null or v.question_id=any(requested_ids))
        and (requested_part is null or v.part=requested_part)
        and (mode<>'review' or exists(select 1 from app_private.review_state r where r.user_id=u and r.question_id=v.question_id and r.status<>'completed'))
    ), groups as (select distinct group_key from candidates), ordering as (select group_key,random() as rank from groups)
    select c.question_id,c.version,c.stem,c.options,c.answer_option_id,c.explanation,c.concept,c.part,c.tracks,c.is_free,c.case_group_id,c.case_stem,c.case_order,c.rights_status,c.review_status,c.published,c.verified_at,c.sources,c.created_at
      from candidates c join ordering o using(group_key) order by o.rank,c.case_order,c.question_id limit n
  loop
    select jsonb_agg(value->'id' order by random()) into option_ids from jsonb_array_elements(q.options);
    items := items || jsonb_build_array(jsonb_build_object('id',q.question_id,'version',q.version,'optionIds',option_ids));
  end loop;
  if jsonb_array_length(items)=0 then raise exception 'APP_NOT_FOUND'; end if;
  if requested_ids is not null and jsonb_array_length(items)<>cardinality(requested_ids) then raise exception 'APP_FORBIDDEN'; end if;
  insert into app_private.practice_sessions(user_id,track,mode,items,created_at,updated_at) values(u,track,mode,items,at_time,at_time) returning * into s;
  result := app_private.record_event(u,event_id,'session',p_request,jsonb_build_object('sessionId',s.id,'sessionVersion',s.version),at_time);
  return result || jsonb_build_object('session',app_private.session_json(u,s.id));
end $$;
create function public.app_get_session(p_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user();
begin
  return jsonb_build_object('session',app_private.session_json(u,p_session_id));
end $$;
create function public.app_submit_attempt(p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); event_id uuid; session_id uuid; old_result jsonb; s app_private.practice_sessions; q app_private.question_versions; ref jsonb; a app_private.attempts; at_time timestamptz := clock_timestamp(); client_time timestamptz; seconds integer; result jsonb; review jsonb;
begin
  perform app_private.assert_object(p_request,array['eventId','sessionId','sessionVersion','questionId','questionVersion','optionId','uncertain','seconds','clientOccurredAt'],array['eventId','sessionId','sessionVersion','questionId','questionVersion','optionId','uncertain']);
  event_id := app_private.valid_uuid(p_request->>'eventId'); session_id := app_private.valid_uuid(p_request->>'sessionId');
  if jsonb_typeof(p_request->'uncertain')<>'boolean' or jsonb_typeof(p_request->'optionId')<>'string' or jsonb_typeof(p_request->'questionId')<>'string'
    or jsonb_typeof(p_request->'questionVersion')<>'number' or (p_request->>'questionVersion')!~ '^\d{1,9}$'
    or jsonb_typeof(p_request->'sessionVersion')<>'number' or (p_request->>'sessionVersion')!~ '^\d{1,15}$' then raise exception 'APP_INVALID'; end if;
  old_result := app_private.event_result(u,event_id,'attempt',p_request);
  if old_result is not null then
    select * into q from app_private.question_versions where question_id=old_result->'attempt'->>'questionId' and version=(old_result->'attempt'->>'questionVersion')::integer;
    select * into s from app_private.practice_sessions where user_id=u and id=session_id;
    if not app_private.can_access(u,q,s.track,at_time) then raise exception 'APP_FORBIDDEN'; end if;
    return old_result || jsonb_build_object('explanation',jsonb_build_object('answerOptionId',q.answer_option_id,'content',q.explanation));
  end if;
  select * into s from app_private.practice_sessions where user_id=u and id=session_id;
  if not found then raise exception 'APP_NOT_FOUND'; end if;
  if s.status<>'active' or s.version<>(p_request->>'sessionVersion')::bigint then raise exception 'APP_CONFLICT'; end if;
  ref := s.items->s.current_index;
  if ref->>'id'<>p_request->>'questionId' or (ref->>'version')::integer<>(p_request->>'questionVersion')::integer then raise exception 'APP_INVALID'; end if;
  if exists(select 1 from app_private.attempts existing where existing.session_id=s.id and existing.ordinal=s.current_index) then raise exception 'APP_CONFLICT'; end if;
  select * into q from app_private.question_versions where question_id=ref->>'id' and version=(ref->>'version')::integer;
  if not app_private.can_access(u,q,s.track,at_time) then raise exception 'APP_FORBIDDEN'; end if;
  if not exists(select 1 from jsonb_array_elements(q.options) where value->>'id'=p_request->>'optionId') then raise exception 'APP_INVALID'; end if;
  if p_request ? 'seconds' and p_request->'seconds'<>'null'::jsonb then
    if jsonb_typeof(p_request->'seconds')<>'number' or (p_request->>'seconds')!~ '^\d{1,5}$' then raise exception 'APP_INVALID'; end if;
    seconds := (p_request->>'seconds')::integer; if seconds>10800 then raise exception 'APP_INVALID'; end if;
  end if;
  if p_request ? 'clientOccurredAt' and p_request->'clientOccurredAt'<>'null'::jsonb then
    if jsonb_typeof(p_request->'clientOccurredAt')<>'string' or (p_request->>'clientOccurredAt')!~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then raise exception 'APP_INVALID'; end if;
    begin client_time := (p_request->>'clientOccurredAt')::timestamptz; exception when others then raise exception 'APP_INVALID'; end;
    if client_time>at_time+interval '5 minutes' then raise exception 'APP_INVALID'; end if;
  end if;
  insert into app_private.attempts(id,user_id,session_id,ordinal,question_id,question_version,part,concept,option_id,correct,uncertain,seconds,mode,accepted_at,hk_day,client_occurred_at,delayed)
    values(event_id,u,s.id,s.current_index,q.question_id,q.version,q.part,q.concept,p_request->>'optionId',p_request->>'optionId'=q.answer_option_id,(p_request->>'uncertain')::boolean,seconds,s.mode,at_time,(at_time at time zone 'Asia/Hong_Kong')::date,client_time,coalesce(client_time<at_time-interval '2 minutes',false)) returning * into a;
  review := app_private.apply_review(u,q.question_id,a.correct,a.uncertain,at_time);
  update app_private.practice_sessions set version=version+1,updated_at=at_time where id=s.id returning * into s;
  result := app_private.record_event(u,event_id,'attempt',p_request,jsonb_build_object('attempt',app_private.attempt_json(a),'review',review,'sessionVersion',s.version),at_time);
  return result || jsonb_build_object('explanation',jsonb_build_object('answerOptionId',q.answer_option_id,'content',q.explanation));
end $$;
create function public.app_advance_session(p_session_id uuid,p_expected_version bigint) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); s app_private.practice_sessions; at_time timestamptz := clock_timestamp(); result jsonb;
begin
  select * into s from app_private.practice_sessions where user_id=u and id=p_session_id;
  if not found then raise exception 'APP_NOT_FOUND'; end if;
  if p_expected_version is null or s.version<>p_expected_version or s.status<>'active' then raise exception 'APP_CONFLICT'; end if;
  if not exists(select 1 from app_private.attempts where session_id=s.id and ordinal=s.current_index) then raise exception 'APP_CONFLICT'; end if;
  update app_private.practice_sessions set current_index=least(current_index+1,jsonb_array_length(items)),
    status=case when current_index+1>=jsonb_array_length(items) then 'completed' else 'active' end,version=version+1,updated_at=at_time where id=s.id returning * into s;
  result := app_private.record_event(u,gen_random_uuid(),'session_progress','{}',jsonb_build_object('sessionId',s.id,'sessionVersion',s.version,'index',s.current_index,'status',s.status),at_time);
  return result || jsonb_build_object('session',app_private.session_json(u,s.id));
end $$;
create function public.app_mark_uncertain(p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); event_id uuid; attempt_id uuid; a app_private.attempts; old_result jsonb; result jsonb; at_time timestamptz := clock_timestamp();
begin
  perform app_private.assert_object(p_request,array['eventId','attemptId'],array['eventId','attemptId']);
  event_id := app_private.valid_uuid(p_request->>'eventId'); attempt_id := app_private.valid_uuid(p_request->>'attemptId');
  old_result := app_private.event_result(u,event_id,'uncertain',p_request); if old_result is not null then return old_result; end if;
  select * into a from app_private.attempts where user_id=u and id=attempt_id;
  if not found then raise exception 'APP_NOT_FOUND'; end if;
  result := jsonb_build_object('attemptId',a.id,'questionId',a.question_id,'review',app_private.apply_review(u,a.question_id,true,true,at_time));
  return app_private.record_event(u,event_id,'uncertain',p_request,result,at_time);
end $$;
create function app_private.usage_totals(p_user uuid) returns jsonb language sql stable set search_path='' as $$
  with combined as (select kind,range_agg(tstzrange(starts_at,ends_at,'[)')) as windows from app_private.usage_segments where user_id=p_user group by kind),
  totals as (select kind,sum(extract(epoch from (upper(w)-lower(w)))) as seconds from combined c cross join lateral unnest(c.windows) w group by kind)
  select jsonb_build_object('foregroundSeconds',coalesce((select seconds from totals where kind='foreground'),0),'effectiveSeconds',coalesce((select seconds from totals where kind='effective'),0));
$$;
create function public.app_add_usage(p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); event_id uuid; old_result jsonb; seg jsonb; requested_segment_id uuid; start_at timestamptz; end_at timestamptz; old_segment app_private.usage_segments; at_time timestamptz := clock_timestamp();
begin
  perform app_private.assert_object(p_request,array['eventId','deviceId','segments'],array['eventId','deviceId','segments']);
  event_id := app_private.valid_uuid(p_request->>'eventId');
  if jsonb_typeof(p_request->'deviceId')<>'string' or length(p_request->>'deviceId') not between 1 and 100 or jsonb_typeof(p_request->'segments')<>'array' or jsonb_array_length(p_request->'segments') not between 1 and 100 then raise exception 'APP_INVALID'; end if;
  old_result := app_private.event_result(u,event_id,'usage',p_request); if old_result is not null then return old_result; end if;
  for seg in select value from jsonb_array_elements(p_request->'segments') loop
    perform app_private.assert_object(seg,array['id','startAt','endAt','kind'],array['id','startAt','endAt','kind']);
    requested_segment_id := app_private.valid_uuid(seg->>'id');
    if seg->>'kind' not in ('foreground','effective') or jsonb_typeof(seg->'kind')<>'string' or jsonb_typeof(seg->'startAt')<>'string' or jsonb_typeof(seg->'endAt')<>'string'
      or seg->>'startAt' !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' or seg->>'endAt' !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then raise exception 'APP_INVALID'; end if;
    begin start_at := (seg->>'startAt')::timestamptz; end_at := (seg->>'endAt')::timestamptz; exception when others then raise exception 'APP_INVALID'; end;
    if end_at<=start_at or end_at-start_at>interval '30 minutes' or end_at>at_time+interval '5 minutes' or start_at<at_time-interval '30 days' then raise exception 'APP_INVALID'; end if;
    select * into old_segment from app_private.usage_segments us where us.user_id=u and us.segment_id=requested_segment_id;
    if found then
      if old_segment.device_id<>p_request->>'deviceId' or old_segment.kind<>seg->>'kind' or old_segment.starts_at<>start_at or old_segment.ends_at<>end_at then raise exception 'APP_CONFLICT'; end if;
    else
      insert into app_private.usage_segments(user_id,segment_id,device_id,kind,starts_at,ends_at,accepted_at) values(u,requested_segment_id,p_request->>'deviceId',seg->>'kind',start_at,end_at,at_time);
    end if;
  end loop;
  if exists (
    select 1 from app_private.usage_segments effective
    where effective.user_id=u and effective.kind='effective' and not coalesce(
      tstzmultirange(tstzrange(effective.starts_at,effective.ends_at,'[)')) <@
      (select range_agg(tstzrange(foreground.starts_at,foreground.ends_at,'[)')) from app_private.usage_segments foreground where foreground.user_id=u and foreground.kind='foreground'),false)
  ) then raise exception 'APP_INVALID'; end if;
  return app_private.record_event(u,event_id,'usage',p_request,jsonb_build_object('totals',app_private.usage_totals(u)),at_time);
end $$;
create function public.app_sync(p_cursor text default '0',p_limit integer default 100) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); after_seq bigint; latest bigint; returned_seq bigint; events jsonb; s app_private.user_settings; profile jsonb;
begin
  if p_cursor is null or p_cursor !~ '^\d{1,18}$' or p_limit is null or p_limit not between 1 and 100 then raise exception 'APP_INVALID'; end if;
  after_seq := p_cursor::bigint;
  select change_seq,jsonb_build_object('id',user_id,'status',status,'createdAt',created_at) into latest,profile from app_private.profiles where user_id=u;
  if after_seq>latest then raise exception 'APP_CONFLICT'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('cursor',e.seq::text,'kind',e.kind,'payload',e.payload,'at',e.accepted_at) order by e.seq),'[]'::jsonb),coalesce(max(e.seq),after_seq)
    into events,returned_seq from (select * from app_private.user_events where user_id=u and seq>after_seq order by seq limit p_limit) e;
  select * into s from app_private.user_settings where user_id=u;
  return jsonb_build_object('events',events,'cursor',returned_seq::text,'hasMore',returned_seq<latest,'settings',s.settings,'settingsVersion',s.version,'profile',profile,'usage',app_private.usage_totals(u));
end $$;

-- Keep helper functions inaccessible, including SECURITY DEFINER helpers.
revoke all on all functions in schema app_private from public,anon,authenticated;
do $$
declare f regprocedure;
begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname in ('app_get_account','app_save_settings','app_create_session','app_get_session','app_submit_attempt','app_advance_session','app_mark_uncertain','app_add_usage','app_sync') loop
    execute format('revoke all on function %s from public,anon',f);
    execute format('grant execute on function %s to authenticated',f);
  end loop;
end $$;

commit;
