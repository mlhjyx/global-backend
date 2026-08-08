import { describe, expect, it } from "vitest";
import { admitRuntimeOpsPostgresVerifier } from "./postgres-verifier-admission";

describe("runtime ops disposable PostgreSQL verifier admission", () => {
  it("fails closed when the explicit destructive verifier authorization is absent", () => {
    expect(() => admitRuntimeOpsPostgresVerifier({})).toThrow(
      "RUNTIME_OPS_POSTGRES_VERIFY_NOT_AUTHORIZED",
    );
  });

  it("rejects production-shaped, remote, shared and mismatched database targets", () => {
    const base = {
      RUNTIME_OPS_ISOLATED_VERIFY: "true",
      RUNTIME_OPS_ISOLATED_DATABASE_NAME: "runtime_ops_disposable_abc123",
      RUNTIME_OPS_ISOLATED_DATABASE_URL:
        "postgresql://tester:password@127.0.0.1:5432/runtime_ops_disposable_abc123",
    };
    expect(() =>
      admitRuntimeOpsPostgresVerifier({
        ...base,
        RUNTIME_OPS_ISOLATED_VERIFY: "yes",
      }),
    ).toThrow("RUNTIME_OPS_POSTGRES_VERIFY_NOT_AUTHORIZED");
    expect(() =>
      admitRuntimeOpsPostgresVerifier({
        ...base,
        RUNTIME_OPS_ISOLATED_DATABASE_URL:
          "postgresql://tester:password@db.example.com:5432/runtime_ops_disposable_abc123",
      }),
    ).toThrow("RUNTIME_OPS_POSTGRES_VERIFY_UNSAFE_TARGET");
    expect(() =>
      admitRuntimeOpsPostgresVerifier({
        ...base,
        RUNTIME_OPS_ISOLATED_DATABASE_URL:
          "postgresql://tester:password@127.0.0.1:5432/global_dev",
      }),
    ).toThrow("RUNTIME_OPS_POSTGRES_VERIFY_UNSAFE_TARGET");
    expect(() =>
      admitRuntimeOpsPostgresVerifier({
        ...base,
        DATABASE_URL: base.RUNTIME_OPS_ISOLATED_DATABASE_URL,
      }),
    ).toThrow("RUNTIME_OPS_POSTGRES_VERIFY_SHARED_TARGET");
  });

  it("admits only an exact loopback disposable database name binding", () => {
    const result = admitRuntimeOpsPostgresVerifier({
      RUNTIME_OPS_ISOLATED_VERIFY: "true",
      RUNTIME_OPS_ISOLATED_DATABASE_NAME: "runtime_ops_disposable_abc123",
      RUNTIME_OPS_ISOLATED_DATABASE_URL:
        "postgresql://tester:password@localhost:5432/runtime_ops_disposable_abc123",
    });
    expect(result.databaseName).toBe("runtime_ops_disposable_abc123");
    expect(result.databaseUrl).toContain("/runtime_ops_disposable_abc123");
  });
});
