import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('API bootstrap runtime admission wiring', () => {
  it('resolves admission before creating the app and listens on the admitted host', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    const admissionIndex = source.indexOf(
      'resolveRuntimeAdmission(process.env)',
    );
    const createIndex = source.indexOf('NestFactory.create(AppModule)');

    expect(admissionIndex).toBeGreaterThan(-1);
    expect(createIndex).toBeGreaterThan(admissionIndex);
    expect(source).toMatch(
      /app\.listen\(runtime\.port,\s*runtime\.apiBindHost\)/u,
    );
    expect(source).not.toMatch(/app\.listen\(port\)/u);
    expect(source).toContain('runtime.corsOrigins');
    expect(source).not.toContain(
      "process.env.NODE_ENV === 'production' ? false : true",
    );
  });
});
