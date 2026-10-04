begin;

create table app_private.rate_limit_windows (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  window_seconds integer not null check (window_seconds between 1 and 86400),
  window_start timestamptz not null,
  hits integer not null check(hits>0),
  primary key(key_hash,window_seconds)
);
create index rate_limit_cleanup on app_private.rate_limit_windows(window_start);
alter table app_private.rate_limit_windows enable row level security;
revoke all on app_private.rate_limit_windows from public,anon,authenticated;
grant all on app_private.rate_limit_windows to service_role;

-- Backend uses HMAC hashes; this accepts neither an email address nor a raw IP.
-- A fixed window is atomic across server instances. It is a limit, not a billing counter.
create function public.app_rate_limit(p_key text,p_limit integer,p_window_seconds integer) returns jsonb language plpgsql security definer set search_path='' as $$
declare start_at timestamptz; at_time timestamptz := clock_timestamp(); hits integer;
begin
  if p_key is null or p_key !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 10000 or p_window_seconds is null or p_window_seconds not between 1 and 86400 then raise exception 'APP_INVALID'; end if;
  start_at := to_timestamp(floor(extract(epoch from at_time)/p_window_seconds)*p_window_seconds);
  insert into app_private.rate_limit_windows(key_hash,window_seconds,window_start,hits) values(p_key,p_window_seconds,start_at,1)
    on conflict(key_hash,window_seconds) do update set
      hits=case when app_private.rate_limit_windows.window_start<excluded.window_start then 1 else app_private.rate_limit_windows.hits+1 end,
      window_start=greatest(app_private.rate_limit_windows.window_start,excluded.window_start)
    returning app_private.rate_limit_windows.hits,app_private.rate_limit_windows.window_start into hits,start_at;
  -- Bounded cleanup; no private payload is logged. The active window is not removed.
  delete from app_private.rate_limit_windows where window_start<at_time-interval '2 days';
  return jsonb_build_object('allowed',hits<=p_limit,'remaining',greatest(p_limit-hits,0),'retryAfter',greatest(ceil(extract(epoch from (start_at+make_interval(secs=>p_window_seconds)-at_time))),1));
end $$;
revoke all on function public.app_rate_limit(text,integer,integer) from public,anon,authenticated;
grant execute on function public.app_rate_limit(text,integer,integer) to service_role;

create table app_private.recovery_intents (
  nonce_hash text primary key check(nonce_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create index recovery_intents_cleanup on app_private.recovery_intents(expires_at);
alter table app_private.recovery_intents enable row level security;
revoke all on app_private.recovery_intents from public,anon,authenticated;
grant all on app_private.recovery_intents to service_role;
create function public.app_register_recovery(p_nonce_hash text,p_user_id uuid,p_expires_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare existing app_private.recovery_intents; at_time timestamptz := clock_timestamp();
begin
  if p_nonce_hash is null or p_nonce_hash !~ '^[0-9a-f]{64}$' or p_user_id is null or p_expires_at is null or p_expires_at<=at_time or p_expires_at>at_time+interval '10 minutes' then raise exception 'APP_INVALID'; end if;
  if not exists(select 1 from auth.users au where au.id=p_user_id and au.email_confirmed_at is not null and not coalesce(au.is_anonymous,false) and (au.banned_until is null or au.banned_until<=at_time)) then raise exception 'APP_UNAUTHENTICATED'; end if;
  insert into app_private.recovery_intents(nonce_hash,user_id,expires_at) values(p_nonce_hash,p_user_id,p_expires_at) on conflict do nothing;
  select * into existing from app_private.recovery_intents where nonce_hash=p_nonce_hash;
  if existing.user_id<>p_user_id or existing.expires_at<>p_expires_at then raise exception 'APP_CONFLICT'; end if;
  if existing.consumed_at is not null then raise exception 'APP_UNAUTHENTICATED'; end if;
  delete from app_private.recovery_intents where expires_at<at_time-interval '1 hour';
  return '{"registered":true}'::jsonb;
end $$;
create function public.app_consume_recovery(p_nonce_hash text,p_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare consumed text; at_time timestamptz := clock_timestamp();
begin
  if p_nonce_hash is null or p_nonce_hash !~ '^[0-9a-f]{64}$' or p_user_id is null then raise exception 'APP_UNAUTHENTICATED'; end if;
  update app_private.recovery_intents set consumed_at=at_time
    where nonce_hash=p_nonce_hash and user_id=p_user_id and consumed_at is null and expires_at>at_time returning nonce_hash into consumed;
  if not found then raise exception 'APP_UNAUTHENTICATED'; end if;
  return '{"consumed":true}'::jsonb;
end $$;
revoke all on function public.app_register_recovery(text,uuid,timestamptz),public.app_consume_recovery(text,uuid) from public,anon,authenticated;
grant execute on function public.app_register_recovery(text,uuid,timestamptz),public.app_consume_recovery(text,uuid) to service_role;

-- authenticated can call Supabase RPC directly, so Node middleware alone is insufficient.
-- An internal per-user database limit closes the successful-write bypass without granting
-- authenticated access to the service RPC. Invalid transactions still need gateway limits.
create function app_private.throttle_user(p_user uuid) returns void language plpgsql set search_path='' as $$
declare result jsonb;
begin
  result := public.app_rate_limit(encode(sha256(convert_to('learning-user:'||p_user::text,'UTF8')),'hex'),120,60);
  if not (result->>'allowed')::boolean then raise exception 'APP_RATE_LIMIT'; end if;
end $$;
revoke all on function app_private.throttle_user(uuid) from public,anon,authenticated;
create or replace function app_private.lock_user() returns uuid language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.verified_user(); account_status text;
begin
  insert into app_private.profiles(user_id) values(u) on conflict do nothing;
  select p.status into account_status from app_private.profiles p where p.user_id=u for update;
  if account_status<>'active' then raise exception 'APP_FORBIDDEN'; end if;
  perform app_private.throttle_user(u);
  insert into app_private.user_settings(user_id) values(u) on conflict do nothing;
  return u;
end $$;
revoke all on function app_private.lock_user() from public,anon,authenticated;

create function app_private.daily_usage(p_user uuid) returns jsonb language sql stable set search_path='' as $$
  with days as (
    select s.kind,d::date as day,
      tstzrange(greatest(s.starts_at,d::date::timestamp at time zone 'Asia/Hong_Kong'),
                least(s.ends_at,(d::date+1)::timestamp at time zone 'Asia/Hong_Kong'),'[)') as segment_window
    from app_private.usage_segments s cross join lateral generate_series((s.starts_at at time zone 'Asia/Hong_Kong')::date::timestamp,
      ((s.ends_at-interval '1 microsecond') at time zone 'Asia/Hong_Kong')::date::timestamp,interval '1 day') d
    where s.user_id=p_user
  ), combined as (select day,kind,range_agg(segment_window) as windows from days group by day,kind),
  totals as (select day,kind,sum(extract(epoch from (upper(w)-lower(w)))) as seconds from combined c cross join lateral unnest(c.windows) w group by day,kind),
  by_day as (select day,jsonb_build_object('foregroundSeconds',coalesce(max(seconds) filter(where kind='foreground'),0),
    'effectiveSeconds',coalesce(max(seconds) filter(where kind='effective'),0)) as totals from totals group by day)
  select coalesce(jsonb_object_agg(day::text,totals),'{}'::jsonb) from by_day;
$$;
create function public.app_export() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); result jsonb;
begin
  -- Only personal records and question/version IDs. Protected content is never exported here.
  select jsonb_build_object('formatVersion',1,'exportedAt',clock_timestamp(),'account',public.app_get_account(),
    'attempts',coalesce((select jsonb_agg(app_private.attempt_json(a) order by a.accepted_at,a.id) from app_private.attempts a where a.user_id=u),'[]'::jsonb),
    'reviews',coalesce((select jsonb_agg(app_private.review_json(u,r.question_id) order by r.question_id) from app_private.review_state r where r.user_id=u),'[]'::jsonb),
    'sessions',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'track',s.track,'mode',s.mode,'items',s.items,'index',s.current_index,'version',s.version,'status',s.status,'createdAt',s.created_at) order by s.created_at,s.id) from app_private.practice_sessions s where s.user_id=u),'[]'::jsonb),
    'usage',app_private.usage_totals(u),'dailyUsage',app_private.daily_usage(u),
    'reading',coalesce((select jsonb_agg(jsonb_build_object('unitId',r.unit_id,'completedAt',r.completed_at) order by r.unit_id) from app_private.reading_progress r where r.user_id=u),'[]'::jsonb)) into result;
  return result;
end $$;
create function public.app_prepare_delete(p_user_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := p_user_id;
begin
  -- Service-only: backend verifies the cookie user and re-authenticates a matching password.
  -- A normal access JWT cannot invoke this mutation or provide a trusted deletion identity.
  if u is null or not exists(select 1 from auth.users au where au.id=u and au.email_confirmed_at is not null and not coalesce(au.is_anonymous,false)
    and (au.banned_until is null or au.banned_until<=clock_timestamp())) then raise exception 'APP_UNAUTHENTICATED'; end if;
  insert into app_private.profiles(user_id) values(u) on conflict do nothing;
  perform 1 from app_private.profiles p where p.user_id=u for update;
  perform app_private.throttle_user(u);
  -- No order/payment tables are enabled in CP3. Any grant is a financial/policy stop.
  if exists(select 1 from app_private.access_grants where user_id=u) then raise exception 'APP_CONFLICT'; end if;
  -- Suspend before admin auth deletion. This RPC alone permits same-user retries while suspended;
  -- every learning/account RPC still fails closed via lock_user(). Identity must be re-verified by the backend.
  update app_private.profiles set status='suspended' where user_id=u;
  return jsonb_build_object('prepared',true,'userId',u);
end $$;
revoke all on function public.app_export() from public,anon;
grant execute on function public.app_export() to authenticated;
revoke all on function public.app_prepare_delete(uuid) from public,anon,authenticated;
grant execute on function public.app_prepare_delete(uuid) to service_role;
revoke all on function app_private.daily_usage(uuid) from public,anon,authenticated;

create or replace function public.app_get_account() returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); result jsonb; at_time timestamptz := clock_timestamp();
begin
  select jsonb_build_object('profile',jsonb_build_object('id',p.user_id,'status',p.status,'createdAt',p.created_at),
    'settings',s.settings,'version',s.version,'settingsVersion',s.version,'cursor',p.change_seq::text,
    'activeSessionId',(select ps.id from app_private.practice_sessions ps where ps.user_id=u and ps.status='active' order by ps.updated_at desc,ps.id limit 1),
    'catalog',coalesce((select jsonb_agg(x.item order by x.track,x.part) from (
       select track,v.part,jsonb_build_object('track',track,'part',v.part,'total',count(*),
       'free',count(*) filter(where v.is_free),'available',count(*) filter(where app_private.can_access(u,v,track,at_time))) as item
       from app_private.question_versions v cross join lateral unnest(v.tracks) track
       where v.published and v.rights_status='approved' and v.review_status='approved' group by track,v.part) x),'[]'::jsonb))
    into result from app_private.profiles p join app_private.user_settings s using(user_id) where p.user_id=u;
  return result;
end $$;
create or replace function public.app_sync(p_cursor text default '0',p_limit integer default 100) returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid := app_private.lock_user(); after_seq bigint; latest bigint; returned_seq bigint; events jsonb; s app_private.user_settings; profile jsonb;
begin
  if p_cursor is null or p_cursor !~ '^\d{1,18}$' or p_limit is null or p_limit not between 1 and 100 then raise exception 'APP_INVALID'; end if;
  after_seq := p_cursor::bigint;
  select change_seq,jsonb_build_object('id',user_id,'status',status,'createdAt',created_at) into latest,profile from app_private.profiles where user_id=u;
  if after_seq>latest then raise exception 'APP_CONFLICT'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('cursor',e.seq::text,'kind',case when e.kind='uncertain' then 'review' when e.kind='session_progress' then 'session' else e.kind end,'payload',e.payload,'at',e.accepted_at) order by e.seq),'[]'::jsonb),coalesce(max(e.seq),after_seq)
    into events,returned_seq from (select * from app_private.user_events where user_id=u and seq>after_seq order by seq limit p_limit) e;
  select * into s from app_private.user_settings where user_id=u;
  return jsonb_build_object('events',events,'cursor',returned_seq::text,'hasMore',returned_seq<latest,'settings',s.settings,'settingsVersion',s.version,'profile',profile,'usage',app_private.usage_totals(u),'dailyUsage',app_private.daily_usage(u));
end $$;
-- CREATE OR REPLACE keeps grants; explicitly re-state them for audit clarity.
revoke all on function public.app_get_account(),public.app_sync(text,integer) from public,anon;
grant execute on function public.app_get_account(),public.app_sync(text,integer) to authenticated;

commit;
