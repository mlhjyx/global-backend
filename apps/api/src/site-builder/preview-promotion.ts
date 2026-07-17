import { access, mkdir, readlink, rename, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

export interface PreviewPromotion {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Prepares a hidden immutable render and a pending symlink without touching the served pointer.
 * commit() performs one atomic rename of that symlink after the DB transaction has committed.
 */
export async function preparePreviewPromotion(input: {
  root: string;
  slug: string;
  buildRunId: string;
}): Promise<PreviewPromotion> {
  if (
    !input.slug ||
    !input.buildRunId ||
    path.basename(input.slug) !== input.slug ||
    path.basename(input.buildRunId) !== input.buildRunId
  ) {
    throw new Error('invalid preview promotion identity');
  }

  const staging = path.join(input.root, '.staging', input.buildRunId);
  const version = path.join(input.root, '.versions', input.buildRunId);
  const activeDir = path.join(input.root, '.active');
  const active = path.join(activeDir, input.slug);
  const pending = path.join(activeDir, `.pending-${input.buildRunId}`);
  const relativeVersion = path.join('..', '.versions', input.buildRunId);

  await Promise.all([
    mkdir(path.dirname(version), { recursive: true }),
    mkdir(activeDir, { recursive: true }),
  ]);
  await rm(pending, { force: true });

  const [hasStaging, hasVersion] = await Promise.all([
    exists(staging),
    exists(version),
  ]);
  if (hasStaging === hasVersion) {
    throw new Error(
      hasStaging
        ? 'staged and immutable preview artifacts both exist'
        : 'preview candidate artifact is missing',
    );
  }

  const movedThisAttempt = hasStaging;
  if (movedThisAttempt) await rename(staging, version);
  await symlink(relativeVersion, pending, 'dir');
  if ((await readlink(pending)) !== relativeVersion) {
    throw new Error(
      'pending preview pointer does not match immutable artifact',
    );
  }

  let settled = false;
  return {
    async commit() {
      if (settled) return;
      // POSIX rename replaces an existing symlink atomically: requests see the old or new target,
      // never an absent slug. The dedicated .active directory never contains real directories.
      await rename(pending, active);
      settled = true;
    },
    async rollback() {
      if (settled) return;
      await rm(pending, { force: true });
      if (movedThisAttempt) await rename(version, staging);
      settled = true;
    },
  };
}
