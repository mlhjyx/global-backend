import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

export const EVALUATION_COMPATIBILITY_SOURCE_ROOT =
  'apps/api/src/site-builder/eval';

export type EvaluationCommandProvenance =
  | 'historical_fixed_source'
  | 'legacy_evaluation_source';

export interface EvaluationCommand {
  readonly name: string;
  readonly legacyEntrypoint: string;
  readonly provenance: EvaluationCommandProvenance;
}

const command = (definition: EvaluationCommand): EvaluationCommand =>
  Object.freeze({ ...definition });

export const evaluationCommands: readonly EvaluationCommand[] = Object.freeze([
  command({
    name: 'aesthetic-review',
    legacyEntrypoint:
      'apps/api/scripts/evaluate-site-builder-aesthetic-review.mts',
    provenance: 'historical_fixed_source',
  }),
  command({
    name: 'blind-visual-calibration',
    legacyEntrypoint:
      'apps/api/scripts/evaluate-site-builder-blind-visual-calibration.mts',
    provenance: 'legacy_evaluation_source',
  }),
  command({
    name: 'blind-visual-calibration-campaign',
    legacyEntrypoint:
      'apps/api/scripts/evaluate-site-builder-blind-visual-calibration-campaign.mts',
    provenance: 'legacy_evaluation_source',
  }),
  command({
    name: 'brand-profile',
    legacyEntrypoint:
      'apps/api/scripts/evaluate-site-builder-brand-profile.mts',
    provenance: 'historical_fixed_source',
  }),
  command({
    name: 'prepare-copy-capability-manifest',
    legacyEntrypoint:
      'apps/api/scripts/prepare-site-builder-copy-capability-manifest.mts',
    provenance: 'legacy_evaluation_source',
  }),
  command({
    name: 'prepare-copy-quality-matrix-manifest',
    legacyEntrypoint:
      'apps/api/scripts/prepare-site-builder-copy-quality-matrix-manifest.mts',
    provenance: 'historical_fixed_source',
  }),
  command({
    name: 'prepare-copy-sonnet-recovery-manifest',
    legacyEntrypoint:
      'apps/api/scripts/prepare-site-builder-copy-sonnet-recovery-manifest.mts',
    provenance: 'legacy_evaluation_source',
  }),
  command({
    name: 'prepare-copy-sonnet-recovery-runtime-binding',
    legacyEntrypoint:
      'apps/api/scripts/prepare-site-builder-copy-sonnet-recovery-runtime-binding.mts',
    provenance: 'legacy_evaluation_source',
  }),
  command({
    name: 'prepare-copy-sonnet-recovery-v22-runtime-binding',
    legacyEntrypoint:
      'apps/api/scripts/prepare-site-builder-copy-sonnet-recovery-v22-runtime-binding.mts',
    provenance: 'legacy_evaluation_source',
  }),
  command({
    name: 'prepare-copy-sonnet-recovery-zero-call-preflight',
    legacyEntrypoint:
      'apps/api/scripts/prepare-site-builder-copy-sonnet-recovery-zero-call-preflight.mts',
    provenance: 'legacy_evaluation_source',
  }),
  command({
    name: 'seed-copy-sonnet-recovery-source-policy',
    legacyEntrypoint:
      'apps/api/scripts/seed-site-builder-copy-sonnet-recovery-source-policy.mts',
    provenance: 'legacy_evaluation_source',
  }),
  command({
    name: 'verify-m1',
    legacyEntrypoint: 'apps/api/scripts/verify-site-builder-m1.mts',
    provenance: 'legacy_evaluation_source',
  }),
]);

export function repositoryRoot(): string {
  return resolve(__dirname, '../../..');
}

export function resolveEvaluationCommand(name: string): EvaluationCommand {
  const command = evaluationCommands.find((candidate) => candidate.name === name);
  if (!command) {
    throw new Error(`UNKNOWN_SITE_BUILDER_EVALUATION_COMMAND:${name}`);
  }
  const entrypoint = resolve(repositoryRoot(), command.legacyEntrypoint);
  if (!existsSync(entrypoint)) {
    throw new Error(
      `SITE_BUILDER_EVALUATION_ENTRYPOINT_UNAVAILABLE:${command.legacyEntrypoint}`,
    );
  }
  return command;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') && !path.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

const EVALUATION_IMPORT =
  /(?:from\s+|import\s*\(|require\s*\()\s*['"][^'"]*(?:site-builder\/eval|(?:^|\/)eval\/)/;

export function findProductEvaluationImports(repoRoot: string): string[] {
  const apiSourceRoot = resolve(repoRoot, 'apps/api/src');
  const compatibilityRoot = resolve(
    repoRoot,
    EVALUATION_COMPATIBILITY_SOURCE_ROOT,
  );
  return sourceFiles(apiSourceRoot)
    .filter((path) => !path.startsWith(`${compatibilityRoot}/`))
    .filter((path) => EVALUATION_IMPORT.test(readFileSync(path, 'utf8')))
    .map((path) => path.slice(repoRoot.length + 1))
    .sort();
}
