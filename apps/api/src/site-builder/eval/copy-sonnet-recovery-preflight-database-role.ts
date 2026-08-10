export type CopySonnetRecoveryDatabaseRole = Readonly<{
  currentUser: string;
  isSuper: boolean;
  bypassRls: boolean;
}>;

export async function assertCopySonnetRecoverySourcePolicyDatabaseRole(
  readRoles: () => Promise<readonly CopySonnetRecoveryDatabaseRole[]>,
): Promise<void> {
  const roles = await readRoles();
  const role = roles[0];
  if (
    roles.length !== 1 ||
    role?.currentUser !== "app_user" ||
    role.isSuper ||
    role.bypassRls
  ) {
    throw new Error("COPY_SONNET_RECOVERY_APP_DATABASE_ROLE_INVALID");
  }
}

export async function runAfterCopySonnetRecoverySourcePolicyRoleCheck<T>(
  readRoles: () => Promise<readonly CopySonnetRecoveryDatabaseRole[]>,
  run: () => Promise<T>,
): Promise<T> {
  await assertCopySonnetRecoverySourcePolicyDatabaseRole(readRoles);
  return run();
}
