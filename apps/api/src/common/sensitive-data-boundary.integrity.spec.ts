import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(__dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(srcRoot, path), "utf8");
}

describe("sensitive data boundary integration", () => {
  it("installs the shared safe logger before HTTP and worker bootstrap", () => {
    const main = source("main.ts");
    const worker = source("temporal/worker.ts");
    expect(main).toMatch(/installSensitiveLogger\s*\(\s*\)/);
    expect(worker).toMatch(/installSensitiveLogger\s*\(\s*\)/);
    expect(main.indexOf("installSensitiveLogger()")).toBeLessThan(
      main.indexOf("NestFactory.create"),
    );
    expect(worker.indexOf("installSensitiveLogger()")).toBeLessThan(
      worker.indexOf(
        "const runtimeTelemetry = await startLangfuseRuntimeTelemetry()",
      ),
    );
  });

  it("admits the explicit worker owner URL before opening telemetry or service connections", () => {
    const worker = source("temporal/worker.ts");
    const admission = worker.indexOf(
      "resolvePlatformOwnerDatabaseUrl(process.env)",
    );
    expect(admission).toBeGreaterThan(-1);
    expect(admission).toBeLessThan(
      worker.indexOf("startLangfuseRuntimeTelemetry()"),
    );
    expect(worker).not.toMatch(
      /new PrismaClient\(\{ datasourceUrl: process\.env\.DATABASE_URL \}\)/,
    );
  });

  it("exports OpenAPI in Nest preview mode without instantiating runtime providers", () => {
    const main = source("main.ts");
    expect(main).toMatch(
      /const exportOpenApi = process\.argv\.includes\(["']--export-openapi["']\)/,
    );
    expect(main).toMatch(
      /NestFactory\.create\(AppModule,\s*\{\s*preview:\s*exportOpenApi\s*\}\)/,
    );
    expect(main.indexOf("const exportOpenApi")).toBeLessThan(
      main.indexOf("NestFactory.create"),
    );
  });

  it("scrubs both persisted AI trace errors and trace write failures", () => {
    const sink = source("model-gateway/ai-trace.sink.ts");
    expect(sink).toMatch(
      /errorMessage:\s*diagnosticErrorToken\(entry\.errorMessage/,
    );
    expect(sink).toMatch(/trace write failed:[^`]*\$\{diagnosticErrorToken\(/s);
    expect(sink).not.toMatch(/String\(err\)\.slice\(/);
  });

  it("scrubs contract-shaped HttpException bodies before returning them", () => {
    const filter = source("common/http-exception.filter.ts");
    expect(filter).toMatch(/json\(scrubSensitiveData\(body\)\)/);
    expect(filter).toMatch(/scrubSensitiveData\(\{\s*error:/s);
    expect(filter).toMatch(/diagnosticErrorSummary\(exception\)/);
  });
});
