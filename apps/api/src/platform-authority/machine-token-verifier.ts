export type RemoteMachineProfile =
  | "capability-request"
  | "temporal-platform-worker"
  | "temporal-customer-worker"
  | "temporal-customer-client";

export interface MachineTokenTrust {
  readonly profile: RemoteMachineProfile;
  readonly issuer: string;
  readonly audience: string;
  readonly subject: string;
  readonly configurationRevision: string;
  readonly jwks: unknown;
}

export interface VerifiedMachineToken {
  readonly token: string;
  readonly expiresAt: number;
  readonly subject: string;
}

export class MachineTokenDeniedError extends Error {
  constructor() {
    super("PLATFORM_MACHINE_TOKEN_DENIED");
  }
}

export async function verifyMachineTokenResponse(
  body: Uint8Array,
  nonce: string,
  trust: MachineTokenTrust,
  now: number,
): Promise<VerifiedMachineToken> {
  try {
    const {
      ClosedJwtObjectParser: Parser,
      canonicalBase64urlBytes: decode,
      strictUtf8,
      validJwksDocument,
    } = createStrictJwtPrimitives(
      MachineTokenDeniedError,
      MachineTokenDeniedError,
    );
    if (
      body.byteLength > 24 * 1024 ||
      !/^[0-9a-f]{32}$/u.test(nonce) ||
      !/^[0-9a-f]{64}$/u.test(trust.configurationRevision) ||
      !Number.isSafeInteger(now) ||
      now < 0
    )
      throw new MachineTokenDeniedError();
    const envelope = new Parser(strictUtf8(body)).parse([
      "schemaVersion",
      "profile",
      "nonce",
      "subject",
      "issuedAt",
      "expiresAt",
      "configurationRevision",
      "token",
    ]);
    if (
      envelope.schemaVersion !== "platform-machine-token/v1" ||
      envelope.profile !== trust.profile ||
      envelope.nonce !== nonce ||
      envelope.subject !== trust.subject ||
      envelope.configurationRevision !== trust.configurationRevision ||
      typeof envelope.token !== "string" ||
      Buffer.byteLength(envelope.token) > 16 * 1024
    )
      throw new MachineTokenDeniedError();
    const segments = envelope.token.split(".");
    if (segments.length !== 3) throw new MachineTokenDeniedError();
    const header = new Parser(strictUtf8(decode(segments[0]!))).parse([
      "alg",
      "kid",
      "typ",
    ]);
    const payload = decode(segments[1]!);
    decode(segments[2]!);
    const capability = trust.profile === "capability-request";
    if (
      header.alg !== "RS256" ||
      typeof header.kid !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(header.kid) ||
      header.typ !==
        (capability
          ? "platform-automation-capability-reader+jwt"
          : "temporal-runtime+jwt")
    )
      throw new MachineTokenDeniedError();
    const common = ["iss", "aud", "sub", "jti", "iat", "nbf", "exp"];
    const claims = capability
      ? new Parser(strictUtf8(payload)).parse([...common, "scope"])
      : new Parser(strictUtf8(payload)).parse(
          [...common, "profile", "permissions"],
          ["permissions"],
        );
    const { iat, nbf, exp } = claims;
    if (
      claims.iss !== trust.issuer ||
      claims.aud !== trust.audience ||
      claims.sub !== trust.subject ||
      typeof claims.jti !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        claims.jti,
      ) ||
      typeof iat !== "number" ||
      typeof nbf !== "number" ||
      typeof exp !== "number" ||
      !Number.isSafeInteger(iat) ||
      !Number.isSafeInteger(nbf) ||
      !Number.isSafeInteger(exp) ||
      iat < 0 ||
      nbf < iat ||
      nbf >= exp ||
      exp - iat !== 300 ||
      iat > now + 60 ||
      nbf > now + 60 ||
      now >= exp ||
      envelope.issuedAt !== iat ||
      envelope.expiresAt !== exp
    )
      throw new MachineTokenDeniedError();
    if (capability) {
      if (
        claims.aud !== "platform-automation-capability-read" ||
        claims.scope !== "platform-automation-capability-read"
      )
        throw new MachineTokenDeniedError();
    } else {
      const permissions: Readonly<Record<string, readonly string[]>> = {
        "temporal-platform-worker": ["platform-automation:worker"],
        "temporal-customer-worker": ["default:worker"],
        "temporal-customer-client": ["default:read", "default:write"],
      };
      const expected = permissions[trust.profile];
      const actualPermissions = claims.permissions;
      if (
        !expected ||
        claims.profile !== trust.profile ||
        !Array.isArray(actualPermissions) ||
        actualPermissions.length !== expected.length ||
        !expected.every((value, index) => actualPermissions[index] === value)
      )
        throw new MachineTokenDeniedError();
    }
    const jwks = await validJwksDocument(trust.jwks);
    const verified = await compactVerify(
      envelope.token,
      createLocalJWKSet({ keys: [...jwks.keys] }),
      { algorithms: ["RS256"] },
    );
    if (!Buffer.from(verified.payload).equals(payload))
      throw new MachineTokenDeniedError();
    return Object.freeze({
      token: envelope.token,
      expiresAt: exp,
      subject: trust.subject,
    });
  } catch {
    throw new MachineTokenDeniedError();
  }
}
import { compactVerify, createLocalJWKSet } from "jose";
import { createStrictJwtPrimitives } from "./strict-jwt-primitives";
