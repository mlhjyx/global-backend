import { access, mkdir, rename, rm } from 'node:fs/promises';
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
 * Atomically swaps one run-scoped render into the slug served by the dev preview.
 * The prior slug directory is retained until the caller confirms its DB transaction committed.
 */
export async function preparePreviewPromotion(input: {
  root: string;
  slug: string;
  buildRunId: string;
}): Promise<PreviewPromotion> {
  if (
    path.basename(input.slug) !== input.slug ||
    path.basename(input.buildRunId) !== input.buildRunId
  ) {
    throw new Error('invalid preview promotion identity');
  }
  const staging = path.join(input.root, '.staging', input.buildRunId);
  const live = path.join(input.root, input.slug);
  const backup = path.join(input.root, '.rollback', input.buildRunId);
  if (!(await exists(staging)))
    throw new Error('staged preview artifact is missing');

  await mkdir(path.dirname(backup), { recursive: true });
  await rm(backup, { recursive: true, force: true });
  const hadLive = await exists(live);
  if (hadLive) await rename(live, backup);
  try {
    await rename(staging, live);
  } catch (error) {
    if (hadLive) await rename(backup, live);
    throw error;
  }

  let settled = false;
  return {
    async commit() {
      if (settled) return;
      settled = true;
      await rm(backup, { recursive: true, force: true });
    },
    async rollback() {
      if (settled) return;
      settled = true;
      await rm(live, { recursive: true, force: true });
      if (hadLive) await rename(backup, live);
      else await rm(backup, { recursive: true, force: true });
    },
  };
}
