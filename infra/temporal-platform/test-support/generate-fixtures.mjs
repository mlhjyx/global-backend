import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const [jwksDirectory, clientDirectory, audience] = process.argv.slice(2);
if (
  !jwksDirectory ||
  !clientDirectory ||
  !isAbsolute(jwksDirectory) ||
  !isAbsolute(clientDirectory) ||
  jwksDirectory === clientDirectory ||
  !audience ||
  !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,190}$/u.test(audience)
) {
  throw new Error("fixture output directory or audience is invalid");
}

await Promise.all([
  mkdir(jwksDirectory, { recursive: true, mode: 0o700 }),
  mkdir(clientDirectory, { recursive: true, mode: 0o700 }),
]);
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2_048,
  publicExponent: 0x10001,
});
const kid = `task4c-${randomUUID()}`;
const publicJwk = publicKey.export({ format: "jwk" });
const jwks = {
  keys: [
    {
      kty: publicJwk.kty,
      use: "sig",
      alg: "RS256",
      kid,
      n: publicJwk.n,
      e: publicJwk.e,
    },
  ],
};

const now = Math.floor(Date.now() / 1_000);
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (subject, permissions, tokenAudience = audience) => {
  const protectedHeader = encode({ alg: "RS256", kid, typ: "JWT" });
  const payload = encode({
    sub: subject,
    aud: tokenAudience,
    permissions,
    jti: randomUUID(),
    iat: now,
    nbf: now - 30,
    exp: now + 1_200,
  });
  const signingInput = `${protectedHeader}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey);
  return `${signingInput}.${signature.toString("base64url")}`;
};

const tokens = {
  "admin.jwt": jwt("task4c-provision-admin", ["temporal-system:admin"]),
  "reader.jwt": jwt("task4c-growthos-reader", ["platform-automation:read"]),
  "writer.jwt": jwt("task4c-backend-schedule-writer", [
    "platform-automation:write",
  ]),
  "worker.jwt": jwt("task4c-backend-worker", [
    "platform-automation:worker",
    "platform-automation:write",
  ]),
  "wrong-audience.jwt": jwt(
    "task4c-wrong-audience",
    ["platform-automation:read"],
    `${audience}-wrong`,
  ),
};

await writeFile(join(jwksDirectory, "jwks.json"), `${JSON.stringify(jwks)}\n`, {
  mode: 0o644,
  flag: "wx",
});
for (const [name, token] of Object.entries(tokens)) {
  await writeFile(join(clientDirectory, name), `${token}\n`, {
    mode: 0o600,
    flag: "wx",
  });
}
const manifest = {
  schemaVersion: "platform-temporal-disposable-fixtures/v1",
  kid,
  audience,
  tokenSha256: Object.fromEntries(
    Object.entries(tokens).map(([name, token]) => [
      name,
      createHash("sha256").update(token).digest("hex"),
    ]),
  ),
};
await writeFile(
  join(clientDirectory, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o600, flag: "wx" },
);

process.stdout.write(
  "generated disposable Temporal public JWKS and bounded token files\n",
);
