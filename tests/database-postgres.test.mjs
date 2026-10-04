import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

// This suite only runs against an explicitly selected disposable PostgreSQL CI database.
// Bootstrap + migrations + db/tests/learning.sql are applied by the CI job first.
const enabled = process.env.RUN_DATABASE_TESTS === '1';
const user = '55555555-5555-4555-8555-555555555555';
const question = 'test-concurrent';
const quote = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${quote(JSON.stringify(value))}::jsonb`;

function psql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], {
      env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '', error = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { error += value; });
    child.on('error', reject);
    child.on('exit', code => {
      if (code !== 0) reject(new Error(`Synthetic database test exited ${code}: ${error.slice(0, 3000)}`));
      else resolve(output.trim().split('\n').filter(Boolean));
    });
    child.stdin.end(sql);
  });
}
const asUser = sql => `begin; set local role authenticated; set local request.jwt.claim.sub = ${quote(user)}; ${sql}; commit;`;
const rpc = (name, request) => `select public.${name}(${json(request)})`;
const lastJSON = lines => JSON.parse(lines.filter(line => line.startsWith('{')).at(-1));

test('PostgreSQL transactions serialize duplicate submissions, review updates and sync cursors', { skip: !enabled, timeout: 45000 }, async () => {
  assert.equal(process.env.PGDATABASE, 'app_test', 'Only the explicitly named disposable CI database is permitted');
  await psql(`
    insert into auth.users(id,email,email_confirmed_at) values(${quote(user)},'concurrent@example.invalid',now());
    insert into auth.sessions(id,user_id) values(${quote(user)},${quote(user)});
    insert into app_private.question_versions(question_id,version,stem,options,answer_option_id,explanation,part,tracks,is_free,rights_status,review_status,published,verified_at)
    values(${quote(question)},1,'Synthetic concurrency question','[{"id":"right","text":"Correct synthetic answer"},{"id":"wrong","text":"Wrong synthetic answer"}]','right',
    '{"core":"Synthetic concept","apply":"Synthetic application","options":{"right":"Correct","wrong":"Wrong"},"memory":"Synthetic aid"}',1,array['eaqe'],true,'approved','approved',true,now());
  `);
  try {
    const session = lastJSON(await psql(asUser(rpc('app_create_session', { eventId: randomUUID(), track: 'eaqe', mode: 'practice', questionIds: [question] }))));
    const request = { eventId: randomUUID(), sessionId: session.sessionId, sessionVersion: 1, questionId: question, questionVersion: 1, optionId: 'wrong', uncertain: false, seconds: 5 };
    const responses = await Promise.all([psql(asUser(rpc('app_submit_attempt', request))), psql(asUser(rpc('app_submit_attempt', request)))]);
    assert.deepEqual(lastJSON(responses[0]), lastJSON(responses[1]));
    const count = await psql(`select count(*) from app_private.attempts where user_id=${quote(user)}::uuid`);
    assert.equal(count.at(-1), '1');

    const s2 = lastJSON(await psql(asUser(rpc('app_create_session', { eventId: randomUUID(), track: 'eaqe', mode: 'review', questionIds: [question] }))));
    const s3 = lastJSON(await psql(asUser(rpc('app_create_session', { eventId: randomUUID(), track: 'eaqe', mode: 'review', questionIds: [question] }))));
    await Promise.all([
      psql(asUser(rpc('app_submit_attempt', { ...request, eventId: randomUUID(), sessionId: s2.sessionId, optionId: 'right' }))),
      psql(asUser(rpc('app_submit_attempt', { ...request, eventId: randomUUID(), sessionId: s3.sessionId, optionId: 'wrong' }))),
    ]);
    const invariants = lastJSON(await psql(`select jsonb_build_object(
      'count',(select count(*) from app_private.attempts where user_id=${quote(user)}::uuid),
      'seq',(select change_seq from app_private.profiles where user_id=${quote(user)}::uuid),
      'maxSeq',(select max(seq) from app_private.user_events where user_id=${quote(user)}::uuid),
      'events',(select count(*) from app_private.user_events where user_id=${quote(user)}::uuid),
      'review',(select app_private.review_json(${quote(user)}::uuid,${quote(question)})),
      'lastReview',(select payload->'review' from app_private.user_events where user_id=${quote(user)}::uuid and kind='attempt' order by seq desc limit 1))`));
    assert.equal(invariants.count, 3);
    assert.equal(invariants.seq, invariants.maxSeq);
    assert.equal(invariants.events, invariants.seq);
    assert.deepEqual(invariants.review, invariants.lastReview);

    // Writer holds the user lock after allocating its cursor, before COMMIT. Reader cannot skip it.
    const writer = psql(asUser(`select public.app_save_settings(1,'{"track":"sqe","examDate":""}'); select pg_sleep(1)`));
    await new Promise(resolve => setTimeout(resolve, 200));
    const reader = psql(asUser(`select public.app_sync(${quote(String(invariants.seq))},100)`));
    const [, readerLines] = await Promise.all([writer, reader]);
    const page = lastJSON(readerLines);
    assert.equal(page.events.length, 1);
    assert.equal(page.events[0].kind, 'settings');
    assert.equal(page.settings.track, 'sqe');
    assert.equal(page.hasMore, false);
  } finally {
    await psql(`delete from auth.users where id=${quote(user)}::uuid; delete from app_private.question_versions where question_id=${quote(question)};`);
  }
});

test('rate limits remain atomic under concurrent service-role calls', { skip: !enabled, timeout: 20000 }, async () => {
  const key = randomUUID().replaceAll('-', '').repeat(2);
  const responses = await Promise.all(Array.from({ length: 8 }, () => psql(`begin; set local role service_role; select public.app_rate_limit(${quote(key)},3,86400); commit;`)));
  assert.equal(responses.map(lastJSON).filter(value => value.allowed).length, 3);
  await psql(`delete from app_private.rate_limit_windows where key_hash=${quote(key)};`);
});

test('recovery proof can be consumed only once across concurrent backend instances', { skip: !enabled, timeout: 20000 }, async () => {
  const recoveryUser = '66666666-6666-4666-8666-666666666666';
  const nonce = randomUUID().replaceAll('-', '').repeat(2);
  await psql(`insert into auth.users(id,email,email_confirmed_at) values(${quote(recoveryUser)},'recovery-concurrent@example.invalid',now());`);
  try {
    await psql(`begin; set local role service_role; select public.app_register_recovery(${quote(nonce)},${quote(recoveryUser)}::uuid,clock_timestamp()+interval '5 minutes'); commit;`);
    const responses = await Promise.allSettled(Array.from({ length: 6 }, () => psql(`begin; set local role service_role; select public.app_consume_recovery(${quote(nonce)},${quote(recoveryUser)}::uuid); commit;`)));
    assert.equal(responses.filter(response => response.status === 'fulfilled').length, 1);
    for (const response of responses.filter(response => response.status === 'rejected')) assert.match(response.reason.message, /APP_UNAUTHENTICATED/);
    const stored = await psql(`select count(*) from app_private.recovery_intents where nonce_hash=${quote(nonce)} and consumed_at is not null;`);
    assert.equal(stored.at(-1), '1');
  } finally {
    await psql(`delete from auth.users where id=${quote(recoveryUser)}::uuid;`);
  }
});
