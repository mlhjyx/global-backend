const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const EXPERIMENT_DATABASE_MARKERS = ['acceptance', 'test', 'experiment'] as const;

type DatabaseTarget = {
  hostname: string;
  port: string;
  database: string;
};

function parseDatabaseTarget(label: string, value: string): DatabaseTarget {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid PostgreSQL URL`);
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new Error(`${label} must use the postgresql protocol`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(`${label} must target localhost, 127.0.0.1, or [::1]`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/gu, ''));
  if (!database || database.includes('/')) {
    throw new Error(`${label} must name exactly one database`);
  }
  return {
    hostname: url.hostname,
    port: url.port || '5432',
    database,
  };
}

/**
 * Fail closed before Prisma constructs a connection. The acceptance may never
 * be pointed at a remote, production-shaped, or different owner/app database.
 */
export function assertIdentityV2LifecycleDatabaseTargets(
  ownerDatabaseUrl: string,
  appDatabaseUrl: string,
): DatabaseTarget {
  const owner = parseDatabaseTarget('DATABASE_URL', ownerDatabaseUrl);
  const app = parseDatabaseTarget('APP_DATABASE_URL', appDatabaseUrl);
  if (
    owner.hostname !== app.hostname ||
    owner.port !== app.port ||
    owner.database !== app.database
  ) {
    throw new Error('DATABASE_URL and APP_DATABASE_URL must target the exact same host, port, and database');
  }
  const lowerDatabase = owner.database.toLowerCase();
  if (!EXPERIMENT_DATABASE_MARKERS.some((marker) => lowerDatabase.includes(marker))) {
    throw new Error('Identity v2 lifecycle database name must contain acceptance, test, or experiment');
  }
  return owner;
}

export function assertIdentityV2LifecycleAppRole(role: {
  role: string;
  superuser: boolean;
  bypassrls: boolean;
} | undefined): void {
  if (!role || role.role !== 'app_user' || role.superuser || role.bypassrls) {
    throw new Error('APP_DATABASE_URL must connect exactly as non-superuser, non-BYPASSRLS app_user');
  }
}
