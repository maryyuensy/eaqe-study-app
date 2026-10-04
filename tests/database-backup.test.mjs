import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

// Opt-in, synthetic-only smoke test. It is not a Supabase backup, deletion
// tombstone or payment reconciliation acceptance test.
const enabled = process.env.RUN_DATABASE_TESTS === '1' && process.env.RUN_DATABASE_BACKUP_TESTS === '1';
const target = 'app_restore_test';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value))}::jsonb`;
function command(name, args, {database = 'app_test', stdin} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, {env: {...process.env, PGDATABASE: database}, stdio: ['pipe', 'pipe', 'pipe']});
    let output = '', error = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { error += value; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(`Synthetic restore smoke exited ${code}: ${error.slice(0, 1200)}`)));
    child.stdin.end(stdin);
  });
}
const psql = (sql, database) => command('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {database, stdin: sql});
const lastJSON = value => JSON.parse(value.split('\n').filter(line => line.startsWith('{')).at(-1));

test('synthetic PostgreSQL backup restores records, RPCs, permissions and RLS into a new disposable database', {skip: !enabled, timeout: 45000}, async () => {
  assert.equal(process.env.PGDATABASE, 'app_test', 'Only app_test can be the source');
  const host = process.env.PGHOST ?? '';
  assert.ok(['localhost', '127.0.0.1', '::1', '/private/tmp', '/tmp'].includes(host), 'Only an explicitly selected local test database can be copied');
  assert.equal(await psql("select count(*) from auth.users where email is null or email !~ '\\.invalid$';"), '0', 'The source cannot contain ordinary user emails');
  assert.equal(await psql(`select count(*) from pg_database where datname=${quote(target)};`), '0', 'Never replace or drop a pre-existing restore target');
  const userId = randomUUID(), questionId = 'test-backup-' + randomUUID().replaceAll('-', ''), attemptId = randomUUID();
  const asUser = sql => `begin; set local role authenticated; set local request.jwt.claim.sub=${quote(userId)}; ${sql}; commit;`;
  const temporary = await mkdtemp(join(tmpdir(), 'eaqe-synthetic-backup-'));
  const archive = join(temporary, 'synthetic.dump');
  let seeded = false, created = false;
  try {
    await psql(`begin;
      insert into auth.users(id,email,email_confirmed_at) values(${quote(userId)},'backup@example.invalid',now());
      insert into auth.sessions(id,user_id) values(${quote(userId)},${quote(userId)});
      insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,part,tracks,is_free,rights_status,review_status,published,verified_at)
      values(${quote(questionId)},1,'Synthetic original backup question','[{"id":"right","text":"Synthetic right"},{"id":"wrong","text":"Synthetic wrong"}]','right',
      '{"core":"Synthetic concept","apply":"Synthetic application","options":{"right":"Correct synthetic answer","wrong":"Wrong synthetic answer"},"memory":"Synthetic aid"}',1,array['eaqe'],true,'approved','approved',true,now()); commit;`);
    seeded = true;
    const session = lastJSON(await psql(asUser(`select public.app_create_session(${json({eventId: randomUUID(), track: 'eaqe', mode: 'practice', questionIds: [questionId]})})`)));
    await psql(asUser(`select public.app_submit_attempt(${json({eventId: attemptId, sessionId: session.sessionId, sessionVersion: 1, questionId, questionVersion: 1, optionId: 'wrong', uncertain: false, seconds: 10})})`));
    const start = new Date(Date.now() - 60000), end = new Date(start.getTime() + 10000);
    await psql(asUser(`select public.app_add_usage(${json({eventId: randomUUID(), deviceId: 'synthetic-backup', segments: [{id: randomUUID(), startAt: start.toISOString(), endAt: end.toISOString(), kind: 'foreground'}]})})`));
    const before = lastJSON(await psql(asUser('select public.app_export()')));
    await command('pg_dump', ['--format=custom', '--file', archive, 'app_test']);
    await command('createdb', ['--maintenance-db=app_test', target]); created = true;
    await command('pg_restore', ['--no-owner', '--exit-on-error', '--dbname', target, archive], {database: target});
    const after = lastJSON(await psql(asUser('select public.app_export()'), target));
    for (const key of ['attempts', 'reviews', 'sessions', 'usage', 'dailyUsage', 'reading']) assert.deepEqual(after[key], before[key], `Restored ${key}`);
    assert.deepEqual(after.account.settings, before.account.settings);
    assert.equal(after.attempts[0].id, attemptId);
    assert.equal(after.attempts[0].correct, false);
    assert.equal(after.reviews[0].status, 'wrong');
    assert.ok(!(JSON.stringify(after)).includes('Synthetic original backup question'), 'Protected question text is not in personal export');
    const concepts = lastJSON(await psql(asUser("select public.app_get_review_concepts('eaqe')"), target));
    assert.equal(concepts.items[0].questionId, questionId);
    assert.equal(await psql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='app_private' and c.relkind='r' and not c.relrowsecurity;", target), '0');
    assert.equal(await psql("select has_function_privilege('anon','public.app_get_account()','EXECUTE');", target), 'f');
    assert.equal(await psql("select has_table_privilege('authenticated','app_private.attempts','INSERT,UPDATE,DELETE');", target), 'f');
    await psql(`delete from auth.users where id=${quote(userId)}::uuid;`, target);
    assert.equal(await psql(`select count(*) from app_private.attempts where user_id=${quote(userId)}::uuid;`, target), '0');
    await assert.rejects(psql(asUser('select public.app_get_account()'), target), /APP_UNVERIFIED/);
  } finally {
    try {
      if (seeded) await psql(`delete from auth.users where id=${quote(userId)}::uuid; delete from app_private.question_versions where question_id=${quote(questionId)};`);
    } finally {
      try { if (created) await command('dropdb', ['--maintenance-db=app_test', target]); }
      finally { await rm(temporary, {recursive: true, force: true}); }
    }
  }
});
