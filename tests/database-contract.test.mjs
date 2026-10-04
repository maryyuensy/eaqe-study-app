import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const root = new URL('../db/', import.meta.url);
const names = (await readdir(new URL('migrations/', root))).filter(name => name.endsWith('.sql')).sort();
const migrations = await Promise.all(names.map(name => readFile(new URL(`migrations/${name}`, root), 'utf8')));
const sql = migrations.join('\n');
const contract = ['app_get_account', 'app_save_settings', 'app_create_session', 'app_get_session', 'app_submit_attempt', 'app_advance_session', 'app_mark_uncertain', 'app_sync', 'app_add_usage', 'app_export', 'app_prepare_delete', 'app_rate_limit', 'app_register_recovery', 'app_consume_recovery', 'app_get_review_concepts'];

test('migrations are numbered, transactional and contain no textbook-derived seed content', () => {
  assert.ok(names.length >= 2);
  for (const [index, migration] of migrations.entries()) {
    assert.match(names[index], /^\d{12}_[-a-z_]+\.sql$/);
    assert.match(migration, /\bbegin;/i);
    assert.match(migration.trimEnd(), /commit;$/i);
    assert.doesNotMatch(migration, /insert\s+into\s+app_private\.question_versions/i);
    assert.doesNotMatch(migration, /sk_live_|sb_secret_|eyJ[a-zA-Z0-9_-]{30}/);
  }
});

test('every public RPC is a definer with an empty search path and explicit execute grants', () => {
  for (const name of contract) {
    assert.match(sql, new RegExp(`create (?:or replace )?function public\\.${name}\\([^;]*?security definer set search_path=''`, 'i'));
    assert.match(sql, new RegExp(`(?:'${name}'|function public\\.${name}\\()`));
  }
  assert.match(sql, /revoke all on all functions in schema app_private from public,anon,authenticated/);
  assert.match(sql, /app_rate_limit\(text,integer,integer\) from public,anon,authenticated/);
  assert.match(sql, /app_rate_limit\(text,integer,integer\) to service_role/);
});

test('user RPC identity comes from verified auth.users and transactional profile locks', () => {
  assert.match(sql, /u uuid := auth\.uid\(\)/);
  assert.match(sql, /au\.email_confirmed_at is not null and not coalesce\(au\.is_anonymous,false\)/);
  assert.match(sql, /where p\.user_id=u for update/);
  for (const name of contract.filter(name => !['app_rate_limit', 'app_register_recovery', 'app_consume_recovery', 'app_prepare_delete'].includes(name))) {
    const parameters = sql.match(new RegExp(`function public\\.${name}\\(([^)]*)\\)`))[1];
    assert.doesNotMatch(parameters, /p_user/);
  }
  assert.match(sql, /update app_private\.profiles set change_seq=change_seq\+1/);
  assert.match(sql, /unique\(user_id,seq\)/);
  assert.match(sql, /perform app_private\.throttle_user\(u\)/);
  assert.match(sql, /APP_RATE_LIMIT/);
  assert.match(sql, /primary key\(key_hash,window_seconds\)/);
  assert.match(sql, /app_prepare_delete\(uuid\) from public,anon,authenticated/);
  assert.match(sql, /app_prepare_delete\(uuid\) to service_role/);
});

test('question access requires rights, content review and a valid server-owned grant', () => {
  assert.match(sql, /p_question\.published and p_question\.rights_status='approved' and p_question\.review_status='approved'/);
  assert.match(sql, /g\.revoked_at is null and g\.starts_at<=p_at and g\.expires_at>p_at/);
  assert.match(sql, /APP_IMMUTABLE_VERSION/);
  assert.match(sql, /session_id,ordinal/);
  assert.match(sql, /'optionIds',option_ids/);
});

test('SQL executable tests cover isolation, atomic retries, HK dates, expiration and usage overlap', async () => {
  const tests = await readFile(new URL('tests/learning.sql', root), 'utf8');
  for (const evidence of ['set local role anon', 'set local role authenticated', 'set local role service_role', 'APP_CONFLICT', 'APP_UNVERIFIED', 'APP_FORBIDDEN', 'APP_IMMUTABLE_VERSION', 'Asia/Hong_Kong', 'Overlapping foreground', 'No pre-answer', 'Other account', 'rollback;']) {
    assert.ok(tests.includes(evidence), `Missing SQL evidence: ${evidence}`);
  }
  assert.ok((tests.match(/pg_temp\.assert_true\(/g) || []).length >= 30);
  assert.ok((tests.match(/pg_temp\.expect_error\(/g) || []).length >= 20);
});

test('review concepts use caller identity, latest approved versions, bounded stable pagination and content access', async () => {
  const migration = await readFile(new URL('migrations/202610040003_review_concepts.sql', root), 'utf8');
  for (const evidence of ['app_private.lock_user()', "r.status<>'completed'", "v.rights_status='approved'", "v.review_status='approved'", 'app_private.can_access(u,v,p_track,at_time)', 'p_limit not between 1 and 50', 'limit p_limit+1', "'hasMore'", 'distinct on (v.question_id)']) assert.ok(migration.includes(evidence));
  const fn = migration.slice(0, migration.indexOf('revoke all on function public.app_get_review_concepts'));
  assert.doesNotMatch(fn, /'answerOptionId'|'options'|'stem'/);
  const proof = await readFile(new URL('tests/review_concepts.sql', root), 'utf8');
  for (const evidence of ['New device', 'Expired paid', 'Second account', 'Catalog counts', 'Historical grade', 'rollback;']) assert.ok(proof.includes(evidence));
});
