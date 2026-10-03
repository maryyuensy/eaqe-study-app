const environments = new Set(['local', 'test', 'preview', 'production']);
const platformEnvironments = {development: 'local', preview: 'preview', production: 'production'};

function roleOf(value) {
  try { return JSON.parse(Buffer.from(value.split('.')[1], 'base64url').toString()).role; }
  catch { return null; }
}

// 報告僅含設定名稱、狀態及固定訊息，不包含設定值或私密資料。
export function inspectEnvironment(env, {requireServices = []} = {}) {
  const issues = [];
  const problem = (variable, message) => issues.push({variable, message});
  const present = key => typeof env[key] === 'string' && env[key].trim() !== '';
  const missing = keys => keys.filter(key => !present(key)).forEach(key => problem(key, '尚未設定。'));
  const services = {auth: false, database: false, payments: false, ai: false};
  if (requireServices.some(service => !Object.hasOwn(services, service))) {
    throw new TypeError('Unknown service requirement');
  }
  const platform = platformEnvironments[env.VERCEL_ENV];
  const environment = env.APP_ENV || platform || 'local';
  if (!environments.has(environment)) problem('APP_ENV', '環境名稱不正確。');
  if (platform && environment !== platform) problem('APP_ENV', '與 Vercel 環境不一致。');
  const local = ['local', 'test'].includes(environment);
  const base = env.APP_BASE_URL || (local ? 'http://localhost:5173' : '');
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || (!local && url.protocol !== 'https:') ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error();
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error();
  } catch { problem('APP_BASE_URL', '需要有效網站 origin；遠端環境必須使用 HTTPS。'); }

  for (const [name, value] of Object.entries(env)) {
    if (!value || !/^(VITE_|NEXT_PUBLIC_|PUBLIC_)/.test(name)) continue;
    if (/SECRET|SERVICE_ROLE|PASSWORD|DATABASE_URL|API_KEY|TOKEN/.test(name) ||
        /^(sb_secret_|sk_(live|test)_|postgres(?:ql)?:)/.test(value) || roleOf(value) === 'service_role') {
      problem(name, '私密設定不可使用前端公開前綴。');
    }
  }

  const authKeys = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY'];
  if (authKeys.some(present) || requireServices.includes('auth')) {
    missing(authKeys);
    if (present('SUPABASE_URL')) {
      try {
        const url = new URL(env.SUPABASE_URL);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error();
      } catch { problem('SUPABASE_URL', '需要 HTTPS 服務網址。'); }
    }
    if (present('SUPABASE_PUBLISHABLE_KEY') &&
        (env.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_secret_') || roleOf(env.SUPABASE_PUBLISHABLE_KEY) === 'service_role')) {
      problem('SUPABASE_PUBLISHABLE_KEY', '不能使用伺服器 secret／service role key。');
    }
    if (present('SUPABASE_SECRET_KEY') &&
        (env.SUPABASE_SECRET_KEY.startsWith('sb_publishable_') || roleOf(env.SUPABASE_SECRET_KEY) === 'anon')) {
      problem('SUPABASE_SECRET_KEY', '不能使用公開 publishable／anon key。');
    }
    services.auth = authKeys.every(present);
  }
  if (present('DATABASE_URL') || requireServices.includes('database')) {
    missing(['DATABASE_URL']);
    if (present('DATABASE_URL')) {
      try {
        const url = new URL(env.DATABASE_URL);
        if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw Error();
      } catch { problem('DATABASE_URL', '需要 PostgreSQL 連線設定。'); }
      services.database = true;
    }
  }
  if (services.auth || services.database) {
    if (!present('DATA_ENV')) problem('DATA_ENV', '必須明確指定資料環境。');
    else if (env.DATA_ENV !== environment) problem('DATA_ENV', '不得跨環境使用資料專案。');
  }

  const paymentMode = env.PAYMENTS_MODE || 'disabled';
  if (!['disabled', 'test'].includes(paymentMode)) problem('PAYMENTS_MODE', '本階段只允許 disabled／test。');
  if (present('STRIPE_SECRET_KEY') && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    problem('STRIPE_SECRET_KEY', '本階段只接受付款測試金鑰。');
  }
  if (paymentMode === 'test' || requireServices.includes('payments')) {
    missing(['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']);
    if (present('STRIPE_WEBHOOK_SECRET') && !env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
      problem('STRIPE_WEBHOOK_SECRET', 'Webhook 設定格式不正確。');
    }
    if (paymentMode !== 'test') problem('PAYMENTS_MODE', '付款驗證要求 test 模式。');
    services.payments = present('STRIPE_SECRET_KEY') && present('STRIPE_WEBHOOK_SECRET') && paymentMode === 'test';
  }
  if (present('AI_PROVIDER') || present('AI_API_KEY') || requireServices.includes('ai')) {
    const aiKeys = ['AI_PROVIDER', 'AI_API_KEY', 'AI_MODEL', 'AI_MONTHLY_BUDGET_HKD', 'AI_ACCOUNT_BUDGET_HKD', 'AI_CHAT_RETENTION_DAYS'];
    missing(aiKeys);
    for (const key of ['AI_MONTHLY_BUDGET_HKD', 'AI_ACCOUNT_BUDGET_HKD']) {
      if (present(key) && (!/^\d+(\.\d{1,2})?$/.test(env[key]) || !Number.isFinite(Number(env[key])) || Number(env[key]) <= 0)) {
        problem(key, '必須明確設定大於零的港元預算。');
      }
    }
    if (present('AI_CHAT_RETENTION_DAYS') &&
        (!/^\d+$/.test(env.AI_CHAT_RETENTION_DAYS) || !Number.isSafeInteger(Number(env.AI_CHAT_RETENTION_DAYS)))) {
      problem('AI_CHAT_RETENTION_DAYS', '必須明確設定非負整數；0 表示不保存對話。');
    }
    if (present('AI_ACCOUNT_BUDGET_HKD') && present('AI_MONTHLY_BUDGET_HKD') &&
        Number(env.AI_ACCOUNT_BUDGET_HKD) > Number(env.AI_MONTHLY_BUDGET_HKD)) {
      problem('AI_ACCOUNT_BUDGET_HKD', '每帳戶預算不能高於整體月預算。');
    }
    services.ai = aiKeys.every(present);
  }
  return {valid: issues.length === 0, environment: environments.has(environment) ? environment : 'invalid', services, issues};
}
