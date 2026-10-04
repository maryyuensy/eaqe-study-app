begin;

-- A new device can request its own pending concepts without loading an old
-- practice session. Every request and page re-checks current content access.
create function public.app_get_review_concepts(p_track text,p_after text default '',p_limit integer default 50)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); at_time timestamptz := clock_timestamp(); result jsonb;
begin
  if p_track is null or p_track not in ('eaqe','sqe') or p_limit is null or p_limit not between 1 and 50
     or p_after is null or (p_after<>'' and p_after !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$') then raise exception 'APP_INVALID'; end if;
  with latest as (
    select distinct on (v.question_id collate pg_catalog."C") v.*
      from app_private.question_versions v join app_private.review_state r on r.question_id=v.question_id
      where r.user_id=u and r.status<>'completed' and v.published and v.rights_status='approved'
        and v.review_status='approved' and v.verified_at is not null
      order by v.question_id collate pg_catalog."C",v.version desc
  ), page as (
    select v.* from latest v where app_private.can_access(u,v,p_track,at_time)
      and v.question_id collate pg_catalog."C">p_after collate pg_catalog."C"
      order by v.question_id collate pg_catalog."C" limit p_limit+1
  ), delivered as (
    select * from page order by question_id collate pg_catalog."C" limit p_limit
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(jsonb_build_object(
       'questionId',d.question_id,'questionVersion',d.version,'part',d.part,
       'concept',coalesce(nullif(d.concept,'未分類'),left(d.explanation->>'core',200),'未分類'),
       'core',d.explanation->>'core','apply',d.explanation->>'apply','memory',d.explanation->>'memory')
       order by d.question_id collate pg_catalog."C") from delivered d),'[]'::jsonb),
       'cursor',coalesce((select question_id from delivered order by question_id collate pg_catalog."C" desc limit 1),p_after),
       'hasMore',(select count(*)>p_limit from page)) into result;
  return result;
end $$;
revoke all on function public.app_get_review_concepts(text,text,integer) from public,anon;
grant execute on function public.app_get_review_concepts(text,text,integer) to authenticated;

-- New samples and catalog counts use one latest published/approved version per
-- stable question ID, retaining the existing one-published-version unique index.
-- Historical references persist; withdrawn versions no longer serve content.
create or replace function public.app_create_session(p_request jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
    with latest as (
      select distinct on (v.question_id) v.* from app_private.question_versions v
      where v.published and v.rights_status='approved' and v.review_status='approved' and v.verified_at is not null
      order by v.question_id,v.version desc
    ), candidates as (
      select v.*,coalesce('case:'||v.case_group_id,'question:'||v.question_id) as group_key from latest v
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

create or replace function public.app_get_account() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); result jsonb; at_time timestamptz := clock_timestamp();
begin
  select jsonb_build_object('profile',jsonb_build_object('id',p.user_id,'status',p.status,'createdAt',p.created_at),
    'settings',s.settings,'version',s.version,'settingsVersion',s.version,'cursor',p.change_seq::text,
    'activeSessionId',(select ps.id from app_private.practice_sessions ps where ps.user_id=u and ps.status='active' order by ps.updated_at desc,ps.id limit 1),
    'catalog',coalesce((with latest as (
       select distinct on (v.question_id) v.* from app_private.question_versions v
       where v.published and v.rights_status='approved' and v.review_status='approved' and v.verified_at is not null
       order by v.question_id,v.version desc)
       select jsonb_agg(x.item order by x.track,x.part) from (
       select track,v.part,jsonb_build_object('track',track,'part',v.part,'total',count(*),
       'free',count(*) filter(where v.is_free),'available',count(*) filter(where app_private.can_access(u,v,track,at_time))) as item
       from latest v cross join lateral unnest(v.tracks) track group by track,v.part) x),'[]'::jsonb))
    into result from app_private.profiles p join app_private.user_settings s using(user_id) where p.user_id=u;
  return result;
end $$;
revoke all on function public.app_create_session(jsonb),public.app_get_account() from public,anon;
grant execute on function public.app_create_session(jsonb),public.app_get_account() to authenticated;

commit;
