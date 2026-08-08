const DISPOSABLE_DATABASE = /^runtime_ops_disposable_[a-z0-9]{6,48}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface RuntimeOpsPostgresVerifierAdmission {
  databaseUrl: string;
  databaseName: string;
}

function unauthorized(): never {
  throw new Error('RUNTIME_OPS_POSTGRES_VERIFY_NOT_AUTHORIZED');
}

function unsafe(): never {
  throw new Error('RUNTIME_OPS_POSTGRES_VERIFY_UNSAFE_TARGET');
}

export function admitRuntimeOpsPostgresVerifier(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeOpsPostgresVerifierAdmission {
  if (env.RUNTIME_OPS_ISOLATED_VERIFY !== 'true') unauthorized();
  const raw = env.RUNTIME_OPS_ISOLATED_DATABASE_URL;
  const expectedName = env.RUNTIME_OPS_ISOLATED_DATABASE_NAME;
  if (!raw || !expectedName || !DISPOSABLE_DATABASE.test(expectedName)) unsafe();

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    unsafe();
  }
  if (!['postgresql:', 'postgres:'].includes(parsed.protocol)) unsafe();
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) unsafe();
  if (!parsed.username || !parsed.password || parsed.search || parsed.hash) unsafe();
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (databaseName !== expectedName || !DISPOSABLE_DATABASE.test(databaseName)) unsafe();

  for (const name of [
    'DATABASE_URL',
    'APP_DATABASE_URL',
    'OWNER_DATABASE_URL',
    'OUTBOX_RELAY_DATABASE_URL',
  ]) {
    if (env[name] && env[name] === raw) {
      throw new Error('RUNTIME_OPS_POSTGRES_VERIFY_SHARED_TARGET');
    }
  }
  return { databaseUrl: raw, databaseName };
}
