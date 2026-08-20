import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { assertRuntimeImageValid } from './runtime-image-verifier.mjs';

const targets = Object.freeze({
  api: '/app/apps/api/dist/main.js',
  worker: '/app/apps/api/dist/temporal/worker.js',
});

const command = process.argv[2];
if (!command || !(command in targets)) {
  throw new Error('runtime entrypoint must be exactly api or worker');
}
const target = targets[command];
await access(target);
await assertRuntimeImageValid('/app');
process.chdir('/app/apps/api');
process.argv = [process.execPath, target, ...process.argv.slice(3)];
await import(pathToFileURL(target).href);
