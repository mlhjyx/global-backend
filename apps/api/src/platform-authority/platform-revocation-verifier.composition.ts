import {
  createBoundedRemoteJwkSet,
  validateExecutionBudgetGrantVerifierConfiguration,
  type ExecutionBudgetJwksFetch,
} from "../execution-budget/execution-budget-grant.verifier";
import { PlatformRevocationVerifier } from "./platform-revocation-verifier";

/** Reuse the bounded GrowthOS execution-family JWKS transport, never a new permissive fetch path. */
export function createPlatformRevocationVerifier(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: { fetcher?: ExecutionBudgetJwksFetch; now?: () => number } = {},
): PlatformRevocationVerifier | null {
  try {
    const configuration = validateExecutionBudgetGrantVerifierConfiguration(env);
    if (!configuration.algorithms.includes("RS256")) return null;
    const keyResolver = createBoundedRemoteJwkSet(
      { ...configuration, algorithms: ["RS256"] }, dependencies.fetcher ?? fetch,
    );
    return new PlatformRevocationVerifier({ issuer: configuration.issuer, keyResolver,
      now: dependencies.now ?? (() => Math.floor(Date.now() / 1000)) });
  } catch { return null; }
}
