import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUSTOMER_TEMPORAL_NAMESPACE,
  RESERVED_PLATFORM_TEMPORAL_NAMESPACE,
  resolveCustomerTemporalConfig,
  resolveCustomerTemporalTlsEnv,
  validateCustomerTemporalReadiness,
} from "./temporal-config";

describe("temporal-config (customer dual-mode SQLite / Postgres Temporal)", () => {
  it("defaults to backward-compatible dev_sqlite mode with namespace=default", () => {
    const config = resolveCustomerTemporalConfig({});
    expect(config).toMatchObject({
      mode: "dev_sqlite",
      namespace: DEFAULT_CUSTOMER_TEMPORAL_NAMESPACE,
      platformNamespace: RESERVED_PLATFORM_TEMPORAL_NAMESPACE,
    });
    expect(validateCustomerTemporalReadiness({})).toEqual({
      ok: true,
      mode: "dev_sqlite",
      namespace: "default",
      issues: [],
    });
  });

  it("blocks namespace collision with platform-automation in both modes", () => {
    const report = validateCustomerTemporalReadiness({
      TEMPORAL_CUSTOMER_BACKEND_MODE: "postgres_platform",
      TEMPORAL_CUSTOMER_ADDRESS: "127.0.0.1:7234",
      TEMPORAL_CUSTOMER_NAMESPACE: "platform-automation",
      TEMPORAL_CUSTOMER_TLS_SERVER_NAME: "temporal.internal",
      TEMPORAL_CUSTOMER_TLS_CA_FILE: "/run/secrets/temporal-ca.pem",
    });
    expect(report.ok).toBe(false);
    expect(report.issues).toContain("TEMPORAL_CUSTOMER_NAMESPACE_COLLISION");
  });

  it("requires explicit address and TLS settings in postgres_platform mode", () => {
    const missing = validateCustomerTemporalReadiness({
      TEMPORAL_CUSTOMER_BACKEND_MODE: "postgres_platform",
      TEMPORAL_CUSTOMER_NAMESPACE: "customer-workflows",
    });
    expect(missing.ok).toBe(false);
    expect(missing.issues).toEqual([
      "TEMPORAL_CUSTOMER_ADDRESS_REQUIRED",
      "TEMPORAL_CUSTOMER_TLS_SERVER_NAME_REQUIRED",
      "TEMPORAL_CUSTOMER_TLS_CA_FILE_REQUIRED",
    ]);

    const ready = validateCustomerTemporalReadiness({
      TEMPORAL_CUSTOMER_BACKEND_MODE: "postgres_platform",
      TEMPORAL_CUSTOMER_ADDRESS: "127.0.0.1:7234",
      TEMPORAL_CUSTOMER_NAMESPACE: "customer-workflows",
      TEMPORAL_CUSTOMER_TLS_SERVER_NAME: "temporal-postgres.internal",
      TEMPORAL_CUSTOMER_TLS_CA_FILE: "/run/secrets/temporal-ca.pem",
    });
    expect(ready).toEqual({
      ok: true,
      mode: "postgres_platform",
      namespace: "customer-workflows",
      issues: [],
    });
  });

  it("overlays TEMPORAL_CUSTOMER_* overrides cleanly for TLS connection resolution", () => {
    const tlsEnv = resolveCustomerTemporalTlsEnv({
      TEMPORAL_ADDRESS: "127.0.0.1:7233",
      TEMPORAL_TLS_SERVER_NAME: "legacy.internal",
      TEMPORAL_TLS_CA_FILE: "/run/secrets/legacy-ca.pem",
      TEMPORAL_CUSTOMER_ADDRESS: "127.0.0.1:7234",
      TEMPORAL_CUSTOMER_TLS_SERVER_NAME: "pg-temporal.internal",
      TEMPORAL_CUSTOMER_TLS_CA_FILE: "/run/secrets/pg-ca.pem",
    });
    expect(tlsEnv.TEMPORAL_ADDRESS).toBe("127.0.0.1:7234");
    expect(tlsEnv.TEMPORAL_TLS_SERVER_NAME).toBe("pg-temporal.internal");
    expect(tlsEnv.TEMPORAL_TLS_CA_FILE).toBe("/run/secrets/pg-ca.pem");
  });

  it("flags unknown backend modes explicitly", () => {
    const report = validateCustomerTemporalReadiness({
      TEMPORAL_CUSTOMER_BACKEND_MODE: "mysql_magic",
    });
    expect(report.ok).toBe(false);
    expect(report.issues).toContain("TEMPORAL_CUSTOMER_BACKEND_MODE_INVALID");
  });
});
