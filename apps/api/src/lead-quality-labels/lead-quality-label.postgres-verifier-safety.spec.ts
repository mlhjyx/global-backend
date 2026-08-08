import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("disposable PostgreSQL verifier implementation safety", () => {
  const source = readFileSync(
    resolve(process.cwd(), "scripts/verify-lead-quality-label-postgres.mts"),
    "utf8",
  );

  it("creates an ephemeral tmpfs container with a Docker-assigned loopback port and exact cleanup target", () => {
    expect(source).toContain('"--tmpfs"');
    expect(source).toContain('"127.0.0.1::5432"');
    expect(source).toContain('"unix:///var/run/docker.sock"');
    expect(source).toContain('docker(["rm", "--force", containerName], true)');
    expect(source).not.toMatch(/docker\s+compose|down\s+-v|rm\s+-rf/);
  });

  it("does not consume an inherited database URL and exercises direct insert, RLS, immutability, and concurrency", () => {
    expect(source).not.toContain("process.env.DATABASE_URL");
    expect(source).toContain("wrong outbox event type");
    expect(source).toContain("cross-workspace app_user insert");
    expect(source).toContain("append-only app_user update");
    expect(source).toContain("referenced handoff identity mutation");
    expect(source).toContain("NOSUPERUSER NOBYPASSRLS");
    expect(source).toContain(
      'ALTER FUNCTION "enforce_lead_quality_label_handoff_identity"() OWNER TO quality_label_trigger_owner',
    );
    expect(source).toContain("Promise.allSettled");
  });
});
