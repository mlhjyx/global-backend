import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  lstatSync,
  type Stats,
} from "node:fs";
import { isAbsolute, normalize, dirname } from "node:path";
import { createHash, createPublicKey } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { createLocalJWKSet, type JWK } from "jose";
import {
  loadPlatformFenceAckMaterial,
  type PlatformFenceAckMaterial,
} from "./platform-fence-ack-keyring";
import { PlatformRevocationVerifier } from "./platform-revocation-verifier";
import { createStrictJwtPrimitives } from "./strict-jwt-primitives";
import {
  loadExecutionBudgetJwks,
  validateExecutionBudgetGrantVerifierConfiguration,
  type ExecutionBudgetJwksFetch,
  type ExecutionBudgetGrantVerifierConfiguration,
} from "../execution-budget/execution-budget-grant.verifier";
import {
  PlatformRevocationHttpError,
  revocationFailure,
} from "./platform-revocation-http.contract";

class TrustUnavailable extends Error {
  constructor() {
    super("PLATFORM_REVOCATION_UNAVAILABLE");
  }
}
const strict = createStrictJwtPrimitives(TrustUnavailable, TrustUnavailable);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function fingerprint(key: JWK): string {
  return hash(
    createPublicKey({
      key: { kty: "RSA", n: key.n!, e: key.e! },
      format: "jwk",
    }).export({ format: "der", type: "spki" }),
  );
}
/** Purpose keyring loader already validates bytes/DER. This adds actual owner,
 * ancestor and unchanged-file provenance, not an env-presence attestation. */
function trustedFile(path: string, secret: boolean): Buffer {
  if (!path || !isAbsolute(path) || normalize(path) !== path)
    return revocationFailure();
  const owner = process.getuid?.();
  const parents = new Map<string, Stats>();
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== 0 && stat.uid !== owner) ||
      ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
    )
      return revocationFailure();
    parents.set(parent, stat);
    if (dirname(parent) === parent) break;
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      (before.uid !== 0n && before.uid !== BigInt(owner ?? -1)) ||
      (before.mode & 0o022n) !== 0n ||
      (secret && (before.mode & 0o7777n) !== 0o600n) ||
      before.size < 1n ||
      before.size > 65536n
    )
      return revocationFailure();
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(
        descriptor,
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!count) break;
      length += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      BigInt(length) !== before.size ||
      length > 65536 ||
      ["dev", "ino", "uid", "gid", "mode", "size", "mtimeNs", "ctimeNs"].some(
        (field) =>
          before[field as keyof typeof before] !==
          after[field as keyof typeof after],
      )
    )
      return revocationFailure();
    for (const [parent, initial] of parents) {
      const current = lstatSync(parent);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== initial.dev ||
        current.ino !== initial.ino ||
        current.uid !== initial.uid ||
        current.gid !== initial.gid ||
        current.mode !== initial.mode
      )
        return revocationFailure();
    }
    return bytes.subarray(0, length);
  } finally {
    closeSync(descriptor);
  }
}
function httpsUri(value: string | undefined): string {
  // eslint-disable-next-line no-control-regex -- Trust-root URLs cannot contain control bytes.
  if (!value || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value))
    return revocationFailure();
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.href !== value ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return revocationFailure();
  return value;
}
interface Snapshot {
  material: PlatformFenceAckMaterial;
  issuer: string;
  ca: Buffer;
  configuration: ExecutionBudgetGrantVerifierConfiguration;
  uris: readonly string[];
  files: readonly { path: string; secret: boolean; digest: string }[];
}
export class PlatformRevocationTrustRuntime {
  #snapshot: Snapshot | null = null;
  #closed = false;
  #active = new Set<AbortController>();
  constructor(
    env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    try {
      const configuration =
        validateExecutionBudgetGrantVerifierConfiguration(env);
      if (!configuration.algorithms.includes("RS256")) return;
      const uris = [
        configuration.jwks.href,
        env.AUTH_JWKS_URI,
        env.SITE_BUILD_BUDGET_GRANT_JWKS_URI,
        env.PLATFORM_CAPABILITY_JWKS_URI,
        env.TEMPORAL_MACHINE_JWKS_URI,
      ].map(httpsUri);
      if (new Set(uris).size !== uris.length) return;
      const files = [
        {
          path: env.PLATFORM_FENCE_ACK_SIGNING_KEYRING_FILE ?? "",
          secret: true,
        },
        {
          path: env.PLATFORM_FENCE_ACK_CIPHER_KEYRING_FILE ?? "",
          secret: true,
        },
        { path: env.PLATFORM_REVOCATION_TRUST_CA_FILE ?? "", secret: false },
      ].map((file) => ({
        ...file,
        digest: hash(trustedFile(file.path, file.secret)),
      }));
      const issuer = env.PLATFORM_FENCE_ACK_ISSUER ?? "";
      const material = loadPlatformFenceAckMaterial({
        signingKeyringFile: files[0].path,
        cipherKeyringFile: files[1].path,
        issuer,
        now,
      });
      this.#snapshot = {
        material,
        issuer,
        uris,
        files,
        ca: trustedFile(files[2].path, false),
        configuration,
      };
      this.assertCurrent();
    } catch {
      this.#snapshot = null;
    }
  }
  assertCurrent(): void {
    try {
      if (this.#closed || !this.#snapshot) return revocationFailure();
      for (const file of this.#snapshot.files)
        if (hash(trustedFile(file.path, file.secret)) !== file.digest)
          return revocationFailure();
    } catch {
      return revocationFailure();
    }
  }
  async open(signal: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const started = performance.now();
    const timer = setTimeout(abort, 2000);
    timer.unref();
    const check = () => {
      if (controller.signal.aborted || performance.now() - started >= 2000)
        return revocationFailure();
      this.assertCurrent();
    };
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    this.#active.add(controller);
    try {
      check();
      const snapshot = this.#snapshot!;
      const fetcher = this.fetcher(snapshot, controller.signal);
      const documents = await Promise.all(
        snapshot.uris.map((uri) =>
          loadExecutionBudgetJwks(
            {
              ...snapshot.configuration,
              jwks: new URL(uri),
              algorithms: ["RS256"],
            },
            fetcher,
            { signal: controller.signal },
          ),
        ),
      );
      check();
      const ackIds = new Set(snapshot.material.jwks.keys.map((k) => k.kid));
      const ackKeys = new Set(snapshot.material.jwks.keys.map(fingerprint));
      for (const document of documents)
        for (const key of document.keys) {
          if (ackIds.has(key.kid!) || ackKeys.has(fingerprint(key)))
            return revocationFailure();
          ackIds.add(key.kid!);
          ackKeys.add(fingerprint(key));
        }
      const verifier = new PlatformRevocationVerifier({
        issuer: snapshot.configuration.issuer,
        keyResolver: createLocalJWKSet({ keys: [...documents[0].keys] }),
        now: this.now,
      });
      return {
        ackIssuer: snapshot.issuer,
        material: snapshot.material,
        verifier,
      };
    } catch {
      return revocationFailure();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.#active.delete(controller);
      abort();
    }
  }
  onModuleDestroy(): void {
    this.#closed = true;
    for (const controller of this.#active) controller.abort();
    this.#active.clear();
  }
  private fetcher(
    snapshot: Snapshot,
    parentSignal: AbortSignal,
  ): ExecutionBudgetJwksFetch {
    return async (input, init) => {
      if (
        !snapshot.uris.includes(input) ||
        init.method !== "GET" ||
        init.redirect !== "error"
      )
        return revocationFailure();
      const signal = init.signal
        ? AbortSignal.any([parentSignal, init.signal])
        : parentSignal;
      const bytes = await new Promise<Buffer>((resolve, reject) => {
        const fail = () =>
          reject(new PlatformRevocationHttpError("unavailable"));
        const req = httpsRequest(
          input,
          {
            method: "GET",
            ca: snapshot.ca,
            rejectUnauthorized: true,
            agent: false,
            signal,
            maxHeaderSize: 8192,
            headers: { Accept: "application/jwk-set+json, application/json" },
          },
          (res) => {
            if (
              res.statusCode !== 200 ||
              !["application/json", "application/jwk-set+json"].includes(
                String(res.headers["content-type"]).split(";", 1)[0],
              ) ||
              (res.headers["content-encoding"] !== undefined &&
                res.headers["content-encoding"] !== "identity")
            ) {
              res.destroy();
              fail();
              return;
            }
            let length = 0;
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => {
              length += chunk.length;
              if (length > 65536) {
                res.destroy();
                fail();
              } else chunks.push(Buffer.from(chunk));
            });
            res.on("error", fail);
            res.on("aborted", fail);
            res.on("end", () => resolve(Buffer.concat(chunks)));
          },
        );
        req.on("error", fail);
        req.end();
      });
      if (signal.aborted) return revocationFailure();
      const document = await strict.validJwksDocument(
        new strict.ClosedJwtObjectParser(strict.strictUtf8(bytes)).parseJwks(),
      );
      return new Response(JSON.stringify(document), {
        status: 200,
        headers: { "Content-Type": "application/jwk-set+json" },
      });
    };
  }
}
