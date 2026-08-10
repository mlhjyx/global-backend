import { createHash } from "node:crypto";

import {
  assertToolExternalActionAuthorized,
  type Tool,
} from "../../tools/tool-contract";
import {
  OPENOX_PRICING_AUTHORITY,
  type OpenOxPricingCatalog,
} from "../site-builder-model-settlement";
import { COPY_SONNET_RECOVERY_CREDENTIAL_PURPOSE } from "./copy-sonnet-recovery-zero-call-preflight-artifact";

export const COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID =
  "openox.pricing_catalog" as const;

const MAXIMUM_RESPONSE_BYTES = 1_048_576;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface CopySonnetRecoveryOpenOxPricingOutput {
  catalog: OpenOxPricingCatalog;
  responseSha256: string;
}

export interface CopySonnetRecoveryOpenOxPricingToolDependencies {
  fetch: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

function fail(): never {
  throw new Error("COPY_SONNET_RECOVERY_OPENOX_RESPONSE_INVALID");
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number(contentLength);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      parsed > MAXIMUM_RESPONSE_BYTES
    ) {
      fail();
    }
  }
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAXIMUM_RESPONSE_BYTES) {
      await reader.cancel();
      fail();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createCopySonnetRecoveryOpenOxPricingTool(
  dependencies: CopySonnetRecoveryOpenOxPricingToolDependencies,
): Tool<Record<string, never>, CopySonnetRecoveryOpenOxPricingOutput> {
  return {
    id: COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID,
    version: "1.0.0",
    category: "structured_source",
    sourceClass: "public_intelligence",
    cost: { unit: "call", estimatedCents: 0, external: true },
    rateLimit: { rps: 1, concurrency: 1 },
    compliance: {
      sourcePolicy: "required",
      policyDomain: "openox.tech",
      respectsRobots: false,
      personalData: false,
      allowedPurpose: [COPY_SONNET_RECOVERY_CREDENTIAL_PURPOSE],
      reversible: true,
      authRequired: false,
      risk: "low",
    },
    capabilities: { produces: [], accepts: [] },
    idempotencyKey: () =>
      `${COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID}:${OPENOX_PRICING_AUTHORITY.catalogEndpoint}`,
    healthCheck: async () => ({ healthy: true, detail: "openox-pricing" }),
    execute: async (_input, ctx) => {
      await assertToolExternalActionAuthorized(ctx);
      const url = `${OPENOX_PRICING_AUTHORITY.origin}${OPENOX_PRICING_AUTHORITY.catalogEndpoint}`;
      const timeoutMs =
        Number.isSafeInteger(dependencies.timeoutMs) &&
        (dependencies.timeoutMs ?? 0) > 0
          ? dependencies.timeoutMs!
          : DEFAULT_TIMEOUT_MS;
      const response = await dependencies.fetch(url, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 300 && response.status < 400) fail();
      if (!response.ok) fail();
      const bytes = await boundedBytes(response);
      let catalog: OpenOxPricingCatalog;
      try {
        catalog = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        ) as OpenOxPricingCatalog;
      } catch {
        fail();
      }
      if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
        fail();
      }
      const responseSha256 = createHash("sha256").update(bytes).digest("hex");
      const fetchedAt = (dependencies.now?.() ?? new Date()).toISOString();
      return {
        data: { catalog, responseSha256 },
        costCents: 0,
        provenance: {
          sourceUrl: url,
          fetchedAt,
          contentHash: responseSha256,
          parserVersion: "openox-pricing-catalog/1",
        },
      };
    },
  };
}
