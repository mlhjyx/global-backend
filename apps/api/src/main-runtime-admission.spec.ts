import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('API bootstrap runtime admission wiring', () => {
  it('routes OpenAPI export through preview mode before runtime admission', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    const exportIndex = source.indexOf(
      "if (process.argv.includes('--export-openapi'))",
    );
    const admissionIndex = source.indexOf(
      'resolveRuntimeAdmission(process.env)',
    );

    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(admissionIndex);
    expect(source).toMatch(
      /NestFactory\.create\(\s*AppModule\.register\(OPENAPI_DOCUMENTATION_RUNTIME\),\s*\{\s*preview:\s*true,/u,
    );
  });

  it('resolves admission before creating the app and listens on the admitted host', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf8');
    const admissionIndex = source.indexOf(
      'resolveRuntimeAdmission(process.env)',
    );
    const createIndex = source.indexOf(
      'NestFactory.create(AppModule.register(runtime))',
    );

    expect(admissionIndex).toBeGreaterThan(-1);
    expect(
      source.match(/resolveRuntimeAdmission\(process\.env\)/gu),
    ).toHaveLength(1);
    expect(createIndex).toBeGreaterThan(admissionIndex);
    const policyIndex = source.indexOf(
      'RoleScopePolicy.parse(runtime.process.environment.AUTH_ROLE_SCOPE_MAP)',
    );
    expect(policyIndex).toBeGreaterThan(admissionIndex);
    expect(policyIndex).toBeLessThan(createIndex);
    expect(source).toMatch(
      /app\.listen\(runtime\.admission\.port,\s*runtime\.admission\.apiBindHost\)/u,
    );
    expect(source).not.toMatch(/app\.listen\(port\)/u);
    expect(source).toContain('runtime.admission.corsOrigins');
    expect(source).not.toContain(
      "process.env.NODE_ENV === 'production' ? false : true",
    );
  });
});
