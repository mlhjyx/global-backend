import { describe, expect, it } from 'vitest';
import {
  APP_DATABASE_ADMISSION_SQL,
  assertApplicationDatabaseAdmission,
  type ApplicationDatabaseAdmissionRow,
} from './app-database-admission';

function admitted(
  overrides: Partial<ApplicationDatabaseAdmissionRow> = {},
): ApplicationDatabaseAdmissionRow {
  return {
    currentUser: 'app_user',
    sessionUser: 'app_user',
    isSuperuser: false,
    bypassesRls: false,
    isDatabaseOwner: false,
    canAssumePrivilegedRole: false,
    ...overrides,
  };
}

describe('application database admission', () => {
  it('accepts only the dedicated non-privileged app_user session', () => {
    expect(() => assertApplicationDatabaseAdmission([admitted()])).not.toThrow();
  });

  it.each([
    ['missing result', []],
    ['different current user', [admitted({ currentUser: 'global' })]],
    ['different session user', [admitted({ sessionUser: 'global' })]],
    ['superuser', [admitted({ isSuperuser: true })]],
    ['BYPASSRLS', [admitted({ bypassesRls: true })]],
    ['database owner', [admitted({ isDatabaseOwner: true })]],
    ['can assume a privileged role', [admitted({ canAssumePrivilegedRole: true })]],
  ])('rejects %s', (_caseName, rows) => {
    expect(() => assertApplicationDatabaseAdmission(rows as ApplicationDatabaseAdmissionRow[])).toThrow(
      /APP_DATABASE_ADMISSION_REJECTED/,
    );
  });

  it('queries current and session role identity plus transitive privileged-role reachability', () => {
    expect(APP_DATABASE_ADMISSION_SQL).toContain('current_user');
    expect(APP_DATABASE_ADMISSION_SQL).toContain('session_user');
    expect(APP_DATABASE_ADMISSION_SQL).toContain('rolbypassrls');
    expect(APP_DATABASE_ADMISSION_SQL).toContain('current_database()');
    expect(APP_DATABASE_ADMISSION_SQL).toContain("pg_has_role('app_user', r.oid, 'MEMBER')");
  });
});
