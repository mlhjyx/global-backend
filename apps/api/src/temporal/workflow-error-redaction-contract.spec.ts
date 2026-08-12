import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Temporal workflow error evidence contract', () => {
  it('never serializes arbitrary thrown error text into workflow history or results', () => {
    const temporalDirectory = __dirname;
    const workflowFiles = readdirSync(temporalDirectory)
      .filter((name) => name.endsWith('.workflow.ts'))
      .sort();

    expect(workflowFiles.length).toBeGreaterThan(0);
    for (const workflowFile of workflowFiles) {
      const source = readFileSync(join(temporalDirectory, workflowFile), 'utf8');
      expect(source, workflowFile).not.toMatch(/String\(err(?:or)?\)/u);
    }
  });
});
