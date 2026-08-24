import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const siteBuilderModuleUrl = new URL('../site-builder/site-builder.module.ts', import.meta.url);
const appModuleUrl = new URL('../app.module.ts', import.meta.url);
const runtimeModuleUrl = new URL('./runtime.module.ts', import.meta.url);

describe('RuntimeReadinessService topology', () => {
  it('has one root provider owned and exported by RuntimeModule', async () => {
    const [siteBuilder, app, runtime] = await Promise.all([
      readFile(siteBuilderModuleUrl, 'utf8'),
      readFile(appModuleUrl, 'utf8'),
      readFile(runtimeModuleUrl, 'utf8'),
    ]);
    expect(siteBuilder).not.toMatch(/providers:\s*\[[\s\S]*?RuntimeReadinessService/);
    expect(app).not.toMatch(/providers:\s*\[[\s\S]*?RuntimeReadinessService/);
    expect(runtime).toMatch(/providers:\s*\[[\s\S]*?RuntimeReadinessService/);
    expect(runtime).toMatch(/exports:\s*\[[\s\S]*?RuntimeReadinessService/);
  });
});
