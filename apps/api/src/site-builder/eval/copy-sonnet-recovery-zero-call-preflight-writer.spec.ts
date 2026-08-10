import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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

function readJsonRegularFile(path: string): { mode: number; value: unknown } {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("TEST_EXPECTED_REGULAR_FILE");
    return {
      mode: stat.mode & 0o777,
      value: JSON.parse(readFileSync(descriptor, "utf8")),
    };
  } finally {
    closeSync(descriptor);
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    chmodSync(root, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Copy Sonnet recovery zero-call evidence writer", () => {
  it("publishes a create-only artifact and a private-parent 0600 secret without leaking it in the summary", async () => {
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
    const secretFile = readJsonRegularFile(secretOutputPath);
    expect(secretFile.mode).toBe(0o600);
    const secret = secretFile.value as Record<string, unknown>;
    expect(secret.tokenId).toBe(24);
    expect(secret.apiKey).toBe(TEST_API_KEY);
    expect(secret.bearerTokenSha256).toBe("b".repeat(64));
    const artifactPath = resolve(
      root,
      COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
    );
    const artifactFile = readJsonRegularFile(artifactPath);
    expect(artifactFile.mode).toBe(0o644);
    expect(artifactFile.value).toEqual(fixture().artifact);
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

  it("preserves an existing secret path and refuses to provision", async () => {
    const root = repository();
    const secretOutputPath = join(temporaryRoot(), "credential.json");
    writeFileSync(secretOutputPath, "existing-secret-owner\n", { mode: 0o600 });
    const provision = vi.fn(async () => fixture());

    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, secretOutputPath),
        { provision, validateArtifact: () => undefined },
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_SECRET_PATH_EXISTS");
    expect(provision).not.toHaveBeenCalled();
    expect(readFileSync(secretOutputPath, "utf8")).toBe(
      "existing-secret-owner\n",
    );
  });

  it("rejects a non-private secret parent before provisioning", async () => {
    const root = repository();
    const secretParent = temporaryRoot();
    chmodSync(secretParent, 0o777);
    const provision = vi.fn(async () => fixture());

    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, join(secretParent, "credential.json")),
        { provision, validateArtifact: () => undefined },
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_SECRET_PARENT_INVALID");
    expect(provision).not.toHaveBeenCalled();
  });

  it("rejects an intermediate symlink that resolves the secret parent outside /tmp", async () => {
    const root = repository();
    const linkContainer = temporaryRoot();
    const outsideRoot = mkdtempSync("/var/tmp/copy-zero-call-writer-");
    temporaryRoots.push(outsideRoot);
    mkdirSync(join(outsideRoot, "private"), { mode: 0o700 });
    symlinkSync(outsideRoot, join(linkContainer, "link"));
    const provision = vi.fn(async () => fixture());

    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(
          root,
          join(linkContainer, "link", "private", "credential.json"),
        ),
        { provision, validateArtifact: () => undefined },
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_SECRET_PATH_INVALID");
    expect(provision).not.toHaveBeenCalled();
    expect(existsSync(join(outsideRoot, "private", "credential.json"))).toBe(
      false,
    );
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

  it("fails closed and removes the secret if its private parent mode drifts", async () => {
    const root = repository();
    const secretOutputPath = join(temporaryRoot(), "credential.json");
    const cleanup = vi.fn(async () => undefined);
    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, secretOutputPath),
        {
          provision: async () => {
            chmodSync(dirname(secretOutputPath), 0o755);
            return fixture();
          },
          cleanup,
          validateArtifact: () => undefined,
        },
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_SECRET_RESERVATION_DRIFT");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(existsSync(secretOutputPath)).toBe(false);
  });

  it("rolls back its artifact and token if the secret parent drifts after publication", async () => {
    const root = repository();
    const secretOutputPath = join(temporaryRoot(), "credential.json");
    const artifactPath = resolve(
      root,
      COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
    );
    const cleanup = vi.fn(async () => undefined);
    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, secretOutputPath),
        {
          provision: async () => fixture(),
          cleanup,
          publishArtifact: async (path, artifact) => {
            writeFileSync(path, `${JSON.stringify(artifact)}\n`, {
              flag: "wx",
              mode: 0o644,
            });
            chmodSync(dirname(secretOutputPath), 0o755);
          },
          validateArtifact: () => undefined,
        },
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_SECRET_RESERVATION_DRIFT");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(existsSync(secretOutputPath)).toBe(false);
    expect(existsSync(artifactPath)).toBe(false);
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

  it("removes the local secret even when remote token cleanup fails", async () => {
    const root = repository();
    const secretOutputPath = join(temporaryRoot(), "credential.json");
    const cleanup = vi.fn(async () => {
      throw new Error("REMOTE_CLEANUP_FAILED");
    });
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
    ).rejects.toThrow("COPY_SONNET_RECOVERY_WRITER_TOKEN_CLEANUP_FAILED");
    expect(cleanup).toHaveBeenCalledOnce();
    expect(existsSync(secretOutputPath)).toBe(false);
  });

  it("preserves a raced evidence target while disabling the new token", async () => {
    const root = repository();
    const secretOutputPath = join(temporaryRoot(), "credential.json");
    const artifactPath = resolve(
      root,
      COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
    );
    const cleanup = vi.fn(async () => undefined);
    await expect(
      writeCopySonnetRecoveryZeroCallPreflightEvidence(
        input(root, secretOutputPath),
        {
          provision: async () => fixture(),
          cleanup,
          validateArtifact: () => {
            writeFileSync(artifactPath, "concurrent-writer\n", {
              flag: "wx",
              mode: 0o644,
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(readFileSync(artifactPath, "utf8")).toBe("concurrent-writer\n");
    expect(existsSync(secretOutputPath)).toBe(false);
  });
});
