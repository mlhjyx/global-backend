import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import {
  renderImageVariant,
  type PlannedImageVariant,
  type RenderedImageVariant,
} from './image-pipeline';

interface ChildRequest {
  inputPath: string;
  outputDir: string;
  plans: PlannedImageVariant[];
}

interface ChildResult {
  outputs: Array<{
    recipeHash: string;
    path: string;
    info: RenderedImageVariant['info'];
  }>;
}

async function main(): Promise<void> {
  const requestPath = process.argv[2];
  const resultPath = process.argv[3];
  if (!requestPath || !resultPath) throw new Error('request and result paths are required');
  sharp.cache(false);
  sharp.concurrency(1);
  const request = JSON.parse(await readFile(requestPath, 'utf8')) as ChildRequest;
  const input = await readFile(request.inputPath);
  const outputs: ChildResult['outputs'] = [];
  for (const plan of request.plans) {
    const rendered = await renderImageVariant(input, plan);
    const outputPath = path.join(request.outputDir, plan.recipeHash);
    await writeFile(outputPath, rendered.data, { mode: 0o600 });
    outputs.push({ recipeHash: plan.recipeHash, path: outputPath, info: rendered.info });
  }
  await writeFile(resultPath, JSON.stringify({ outputs } satisfies ChildResult), { mode: 0o600 });
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
