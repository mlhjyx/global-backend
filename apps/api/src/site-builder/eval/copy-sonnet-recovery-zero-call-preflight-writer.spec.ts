import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH } from "./copy-sonnet-recovery-zero-call-preflight-artifact";
import { writeCopySonnetRecoveryZeroCallPreflightEvidence } from "./copy-sonnet-recovery-zero-call-preflight-writer";

const temporaryRoots: string[] = [];
const TEST_API_KEY = ["sk", "writer", "test", "secret"].join("-");

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "copy-zero-call-writer-"));
  temporaryRoots.push(root);
  return root;
}

function fixture() {
  return {
    secret: { tokenId: 24, apiKey: TEST_API_KEY },
    artifact: {
      artifactId:
        "site-builder-copy-sonnet-recovery-zero-call-preflight/2026-08-10-v16-v1",
      artifactDigest: "a".repeat(64),
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedModelWireCalls: 0,
      credential: {
        purpose: "site_builder_copy_sonnet_recovery",
        tokenId: 24,
        bearerTokenSha256: "b".repeat(64),
        expiresAt: "2026-08-11T06:00:00.000Z",
        quotaCapPoints: 151_264,
      },
      route: { channelId: 22 },
      pricing: {
        currency: "USD",
        inputPriceMicrounitsPerMillionTokens: 2_000_000,
        outputPriceMicrounitsPerMillionTokens: 10_000_000,
        maximumNativeCostMicrounits: 302_528,
      },
    },
  };
}

function input(repositoryRoot: string, secretOutputPath: string) {
  return {
    repositoryRoot,
    secretOutputPath,
    executionHeadCommit: "2c1553dfb862d290c6c0933b4362c766ee1bf58e",
    runtimeBindingBytes: new Uint8Array([123, 125]),
    adminBaseUrl: "http://127.0.0.1:3001",
    gatewayOrigin: "http://127.0.0.1:3001",
    adminAccessToken: "admin-test-value",
    adminUserId: 1,
  };
}

function repository(): string {
  const root = temporaryRoot();
  mkdirSync(
    resolve(
      root,
      COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
      "..",
    ),
    { recursive: true },
  );
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Copy Sonnet recovery zero-call evidence writer", () => {
  it("publishes a create-only artifact and a direct /tmp 0600 secret without leaking it in the summary", async () => {
    const root = repository();
    const secretOutputPath = join(temporaryRoot(), "credential.json");
    const provision = vi.fn(async () => fixture());
    const cleanup = vi.fn(async () => undefined);

    const summary = await writeCopySonnetRecoveryZeroCallPreflightEvidence(
      input(root, secretOutputPath),
      {
        provision,
        cleanup,
        validateArtifact: () => undefined,
      },
    );

    expect(provision).toHaveBeenCalledOnce();
    expect(cleanup).not.toHaveBeenCalled();
    expect(lstatSync(secretOutputPath).mode & 0o777).toBe(0o600);
    const secret = JSON.parse(readFileSync(secretOutputPath, "utf8"));
    expect(secret.tokenId).toBe(24);
    expect(secret.apiKey).toBe(TEST_API_KEY);
    expect(secret.bearerTokenSha256).toBe("b".repeat(64));
    const artifactPath = resolve(
      root,
      COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
    );
    expect(lstatSync(artifactPath).mode & 0o777).toBe(0o644);
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(
      fixture().artifact,
    );
    expect(JSON.stringify(summary)).not.toContain("writer-test-secret");
    expect(summary).toMatchObject({
      outputPath: COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
      secretOutputPath,
      tokenId: 24,
      dispatchAuthorization: "NOT_AUTHORIZED",
      dispatchCapable: false,
      observedModelWireCalls: 0,
    });
  });

  it("rejects unsafe secret or existing artifact paths before provisioning", async () => {
    const root = repository();
    const unsafeProvision = vi.fn(async () => fixture());
    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, "/var/tmp/copy-recovery-secret-forbidden.json"),
        { provision: unsafeProvision, validateArtifact: () => undefined },
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_SECRET_PATH_INVALID");
    expect(unsafeProvision).not.toHaveBeenCalled();

    const artifactPath = resolve(
      root,
      COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
    );
    writeFileSync(artifactPath, "historical\n", { mode: 0o644 });
    const provision = vi.fn(async () => fixture());
    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, join(temporaryRoot(), "credential.json")),
        { provision, validateArtifact: () => undefined },
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_EVIDENCE_EXISTS");
    expect(provision).not.toHaveBeenCalled();
  });

  it("removes the reserved secret path on preflight failure", async () => {
    const root = repository();
    const secretOutputPath = join(temporaryRoot(), "credential.json");
    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, secretOutputPath),
        {
          provision: async () => {
            throw new Error("LIVE_PREFLIGHT_FAILED");
          },
          validateArtifact: () => undefined,
        },
      ),
    ).rejects.toThrow("LIVE_PREFLIGHT_FAILED");
    expect(existsSync(secretOutputPath)).toBe(false);
  });

  it("disables the created purpose token and removes its secret if artifact publication fails", async () => {
    const root = repository();
    const secretOutputPath = join(temporaryRoot(), "credential.json");
    const cleanup = vi.fn(async () => undefined);
    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, secretOutputPath),
        {
          provision: async () => fixture(),
          cleanup,
          publishArtifact: async () => {
            throw new Error("ARTIFACT_WRITE_FAILED");
          },
          validateArtifact: () => undefined,
        },
      ),
    ).rejects.toThrow("ARTIFACT_WRITE_FAILED");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(existsSync(secretOutputPath)).toBe(false);
  });
});
