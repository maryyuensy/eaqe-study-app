-- CI ONLY. Never apply this auth/role shim to a Supabase project.
-- PostgreSQL 16 is launched as an empty, disposable database by CI.
\set ON_ERROR_STOP on
do $$
begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role nologin bypassrls; end if;
end $$;
create schema auth;
create table auth.users (
  id uuid primary key,
  email text unique,
  email_confirmed_at timestamptz,
  is_anonymous boolean not null default false,
  banned_until timestamptz
);
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  not_after timestamptz
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
$$;
grant usage on schema auth to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,jsonb_build_object('session_id',auth.uid()::text));
$$;
grant execute on function auth.jwt() to anon,authenticated,service_role;
