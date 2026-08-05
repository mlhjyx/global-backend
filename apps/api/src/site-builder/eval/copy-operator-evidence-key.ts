import { createHash, createPublicKey } from "node:crypto";

export const COPY_OPERATOR_EVIDENCE_KEY_ID =
  "copy-evidence-operator-2026-08-v1" as const;

export const COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAmEnaw0hrfEomhxcrw20s5RV5JnxrcjcpEQ5te77Xhso=
-----END PUBLIC KEY-----
` as const;

export const COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256 = createHash("sha256")
  .update(
    createPublicKey(COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_PEM).export({
      format: "der",
      type: "spki",
    }),
  )
  .digest("hex");

if (
  COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_SHA256 !==
  "90a80a686b217df4a524a709d940ca9cc133348722e8d611aa4cb2549b21dca7"
) {
  throw new Error("COPY_OPERATOR_EVIDENCE_PUBLIC_KEY_DRIFT");
}
