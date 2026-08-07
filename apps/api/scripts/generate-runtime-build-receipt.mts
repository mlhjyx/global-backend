import { resolve } from 'node:path';
import { generateRuntimeBuildReceipt } from '../src/runtime/build-receipt';

const KNOWN_OPTIONS = new Set([
  '--artifact-root',
  '--receipt-path',
  '--source-sha',
  '--build-time',
  '--migration-root',
  '--expected-artifact-digest',
  '--expected-migration-manifest-digest',
]);

function parseOptions(args: readonly string[]): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  for (let index = 0; index < normalizedArgs.length; index += 1) {
    const token = normalizedArgs[index]!;
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!KNOWN_OPTIONS.has(name)) throw new Error(`unknown option: ${name}`);
    if (values.has(name)) throw new Error(`duplicate option: ${name}`);
    const value =
      equals === -1 ? normalizedArgs[index + 1] : token.slice(equals + 1);
    if (
      value === undefined ||
      value === '' ||
      (equals === -1 && value.startsWith('--'))
    ) {
      throw new Error(`missing value for ${name}`);
    }
    values.set(name, value);
    if (equals === -1) index += 1;
  }
  return values;
}

function required(options: ReadonlyMap<string, string>, name: string): string {
  const value = options.get(name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const artifactRoot = resolve(
    options.get('--artifact-root') ?? resolve(import.meta.dirname, '../dist'),
  );
  const receiptPath = options.get('--receipt-path');
  const migrationRoot = resolve(
    options.get('--migration-root') ??
      resolve(import.meta.dirname, '../../../packages/db/prisma/migrations'),
  );
  const receipt = await generateRuntimeBuildReceipt({
    artifactRoot,
    migrationRoot,
    ...(receiptPath ? { receiptPath: resolve(receiptPath) } : {}),
    buildSha: required(options, '--source-sha'),
    buildTime: required(options, '--build-time'),
    ...(options.has('--expected-artifact-digest')
      ? { expectedArtifactDigest: options.get('--expected-artifact-digest') }
      : {}),
    ...(options.has('--expected-migration-manifest-digest')
      ? {
          expectedMigrationManifestDigest: options.get(
            '--expected-migration-manifest-digest',
          ),
        }
      : {}),
  });
  console.log(
    `[runtime-build-receipt] wrote ${receipt.schemaVersion} for ${receipt.buildSha}`,
  );
}

main().catch((error: unknown) => {
  console.error(
    `[runtime-build-receipt] failed: ${error instanceof Error ? error.message : 'unknown error'}`,
  );
  process.exitCode = 1;
});
