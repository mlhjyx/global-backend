import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(import.meta.dirname, '..');
const CONTROL_MESSAGE =
  /EXECUTION_BUDGET_|EXECUTIONBUDGET|BUDGET_|BUDGET.*ERROR|BUDGETOPERATIONREPLAY|BUDGETSTORE|BUDGETEXCEEDED|PAIDOPERATIONUNKNOWN|DOMAIN_ACK_|DOMAINACK|DURABLE_EXECUTION_RECEIPT_|DURABLEEXECUTIONRECEIPT|GENERIC_OPERATION_ARTIFACT_|GENERICOPERATIONARTIFACT|ARTIFACTSTORAGEERROR|DURABLE_REPLAY_|_REPLAY_/u;
const NEW_ERROR_LITERAL =
  /new\s+Error\s*\(\s*(?:'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`)/gu;
const MESSAGE_ONLY_NON_CLASSIFIER_PATHS = Object.freeze(new Set([
  'model-gateway/providers/openai-compatible.provider.ts',
  'model-gateway/vision-review-input.ts',
  'site-builder/agents/controlled-assembly.ts',
  'site-builder/assembly/copy-slot-derivation.ts',
  'site-builder/copy-bundle.service.ts',
  'site-builder/site-build-budget-grant.ts',
  'temporal/site-builder.activities.ts',
]));

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Evaluation runners are isolated non-product entrypoints and do not use
      // the shared Provider/Workflow classifier. They retain their own fixed
      // campaign replay errors and are reviewed under the evaluation gates.
      return path.endsWith(join('site-builder', 'eval'))
        ? []
        : productionSources(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

describe('execution control producer structure', () => {
  it('forbids classifier control tokens that exist only in a production Error message', () => {
    const violations = productionSources(SOURCE_ROOT).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      const relativePath = relative(SOURCE_ROOT, path);
      if (MESSAGE_ONLY_NON_CLASSIFIER_PATHS.has(relativePath)) {
        // These exact Copy/Site Builder/Vision surfaces are owned by their
        // private retry/failure contracts and never import or call the shared
        // execution-control classifier. Keeping them outside this migration
        // also preserves their fixed-source governance. Any future classifier
        // import makes this proof fail and requires a structured producer.
        expect(source).not.toMatch(
          /execution-control-error|isExecutionControlError/u,
        );
        return [];
      }
      return [...source.matchAll(NEW_ERROR_LITERAL)].flatMap((match) => {
        const message = (match[1] ?? match[2] ?? match[3] ?? '').toUpperCase();
        return CONTROL_MESSAGE.test(message)
          ? [`${relativePath}:${source.slice(0, match.index).split('\n').length}`]
          : [];
      });
    });

    expect(violations).toEqual([]);
  });
});
