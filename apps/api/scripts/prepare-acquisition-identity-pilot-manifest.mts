import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  buildControlledPilotManifest,
  validateControlledPilotFixture,
  validateControlledPilotManifest,
  writeControlledPilotManifestCreateOnly,
} from '../src/acquisition/controlled-pilot-manifest';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixtureRelativePath = 'docs/evidence/acquisition/german-industrial-pump-pilot-fixture-v1.json';
const outputRelativePath = 'docs/evidence/acquisition/acquisition-identity-pilot-prep-manifest-v1.json';
const options = parseArgs(process.argv.slice(2));
const fixture = validateControlledPilotFixture(
  JSON.parse(await readFile(resolve(repositoryRoot, fixtureRelativePath), 'utf8')) as unknown,
);
const expected = buildControlledPilotManifest({
  fixture,
  fixturePath: fixtureRelativePath,
  sourceCommit: options.sourceCommit,
  expiresAt: options.expiresAt,
});
const outputPath = resolve(repositoryRoot, outputRelativePath);

if (options.verify) {
  const actual = validateControlledPilotManifest(JSON.parse(await readFile(outputPath, 'utf8')) as unknown);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('pilot prep manifest differs from explicit inputs');
  process.stdout.write(`verified ${outputRelativePath}\n`);
} else {
  await writeControlledPilotManifestCreateOnly(outputPath, expected);
  process.stdout.write(`created ${outputRelativePath}\n`);
}

function parseArgs(args: string[]): { sourceCommit: string; expiresAt: string; verify: boolean } {
  let sourceCommit: string | undefined;
  let expiresAt: string | undefined;
  let verify = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--verify') {
      if (verify) throw new Error('duplicate --verify');
      verify = true;
      continue;
    }
    if (arg === '--source-commit' || arg === '--expires-at') {
      const next = args[index + 1];
      if (!next || next.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--source-commit') {
        if (sourceCommit) throw new Error('duplicate --source-commit');
        sourceCommit = next;
      } else {
        if (expiresAt) throw new Error('duplicate --expires-at');
        expiresAt = next;
      }
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${arg}`);
  }
  if (!sourceCommit || !expiresAt) throw new Error('--source-commit and --expires-at are required');
  return { sourceCommit, expiresAt, verify };
}
