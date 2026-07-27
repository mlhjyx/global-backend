#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadModelCandidateBaseline,
  renderModelCandidateBaselineDocument,
  validateModelCandidateBaseline,
} from './model-candidate-baseline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = loadModelCandidateBaseline(root);
const errors = validateModelCandidateBaseline(baseline);
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

const outputPath = join(root, baseline.documentationPolicy.canonicalDocument);
const expected = renderModelCandidateBaselineDocument(baseline);
if (process.argv.includes('--check')) {
  const actual = readFileSync(outputPath, 'utf8');
  if (actual !== expected) {
    console.error(
      `${baseline.documentationPolicy.canonicalDocument} differs from ${baseline.candidateBaselineId}`,
    );
    process.exit(1);
  }
  console.log(
    `model candidate baseline check PASS — ${baseline.candidateBaselineId}`,
  );
} else {
  writeFileSync(outputPath, expected);
  console.log(
    `generated ${baseline.documentationPolicy.canonicalDocument} from ${baseline.candidateBaselineId}`,
  );
}
