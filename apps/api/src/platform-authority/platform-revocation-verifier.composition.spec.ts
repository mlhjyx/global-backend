import { describe, expect, it, vi } from "vitest";
import { createPlatformRevocationVerifier } from "./platform-revocation-verifier.composition";

const env = {
  APP_ENVIRONMENT: "development", NODE_ENV: "development",
  EXECUTION_BUDGET_GRANT_JWKS_URI: "http://127.0.0.1:18081/.well-known/execution-budget-jwks.json",
  EXECUTION_BUDGET_GRANT_ISSUER: "http://127.0.0.1:18081/",
  EXECUTION_BUDGET_GRANT_AUDIENCE: "global-backend:execution-budget",
  EXECUTION_BUDGET_GRANT_ALGORITHMS: "RS256",
};
describe("revocation production trust composition", () => {
  it("stays unavailable for missing or non-RSA trust without attempting network", () => {
    const fetcher = vi.fn();
    expect(createPlatformRevocationVerifier({}, { fetcher })).toBeNull();
    expect(createPlatformRevocationVerifier({ ...env, EXECUTION_BUDGET_GRANT_ALGORITHMS: "ES256" }, { fetcher })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("composes lazily from the same bounded execution signing trust root", () => {
    const fetcher = vi.fn();
    expect(createPlatformRevocationVerifier(env, { fetcher })).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not accept an insecure remote trust endpoint", () => {
    expect(createPlatformRevocationVerifier({ ...env, EXECUTION_BUDGET_GRANT_JWKS_URI: "http://remote.example/jwks" })).toBeNull();
  });
});
