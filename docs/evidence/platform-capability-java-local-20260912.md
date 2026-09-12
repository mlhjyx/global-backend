# Platform capability Java signing: local source verification

Scope: local source, test and cross-language verification only. This is not
hosted cross-repository CI, a deployed producer, a RuntimeEvidence record or
Release Bundle. No live key, service token, provider request or customer data
was used. All signature keys were generated for isolated tests; only public
keys and synthetic signed test vectors were retained.

## Exact sources

| Subject | Binding |
| --- | --- |
| GrowthOS archive | `5906e7a287843c7bafd8d7bb20aa930d1ae97eb6cf2946110d27ecc3a5dfc75a` |
| Codec patch0101 | `a6191b99c5f662945fd852663d6a238355da9f2420a8ea54198b96880c0285ec` |
| Signing/JWKS patch0102 | `9b0e80db0e72b0d7e2f3daa057fe3940d2969d91b8d4c34965cebedb75292498` |
| Java local delivery receipt SHA256 | `5eb6b28759932ebfaa7c388e6b83b73179fa3bb7a4ec12c4a06fc7f359f03c83` |
| Actual Java signed artifact SHA256 | `2e1ba34054df4f45989a5e7ef7a7944397614431aaded18c18d9f1f5e0ff785e` |
| Backend receiver candidate | [PR #515](https://github.com/mlhjyx/global-backend/pull/515), base `6a3126b7670661a64c95676574320a3f6992ee66` |
| Backend local vector/test commit | `a56665123572b9471dff2761fb87cb3eb6472c9a`, not pushed at this observation |
| Structured test vector SHA256 | `e22516c8bb816285b4e2abfeba9db04ab21748d152c6f6d77288686754b817a5` |

The archive+patch writer remains a local candidate; neither the authority
directory nor a running GrowthOS image was changed by these tests. Patch0099's
revocation integration HOLD remains. The receipt and raw local reports are task
artifacts, not independently hosted attestations; their digests above bind this
summary to the observed local files.

## Observed checks

- Java: 35 tests passed, zero failures/errors/skips: 11 new signing/JWKS, 14
  codec, 10 existing keyring/signer/JWKS regression tests. The six signing tests
  were rechecked after adding a valid-signature wrong-audience fixture; unchanged
  checks were reused.
- Four new production classes: 56/58 lines, 20/22 branches, 293/298 instructions,
  15/15 methods. Single-fork coverage was used; the earlier overwritten multi-fork
  result was rejected. JaCoCo XML SHA256:
  `8172b853709240f86a1c4de8a5367293075e140f3ccb155ed7d709ba999a0a32`.
- Actual Java `GlobalBackendJwtSigner` output was accepted by the TypeScript
  verifier without Node signing. Lowercase control escapes, Chinese and emoji
  preserve canonical bytes and NumericDate/fact deadlines.
- The negative audience token first passed independent RSA signature verification,
  then failed the capability audience check. Corrupted signatures, nonce/source/
  key-family substitution and expired underlying facts also failed closed.
- Backend: seven capability test files, 111 tests passed. Regression log SHA256:
  `1ec927809d45ac5145328e41cb04626a2f56493d0bc02ed0ca692548cf5fa55d`.
- Archive materialization: 7/7 passed after manifest registration. Backend
  targeted lint, formatting, governance190, docs and committed ContractGraph
  checks passed. These are local checks, not new hosted CI.
- Gitleaks found no leaks with no new exemptions. Scan log SHA256:
  `db40f6de7b6b4c310a5b34fea3e83ea282ca6751f13fb0ec475cd1e16b04780e`.

The structured fixture stores the three original JWS segments. Joining those
segments reproduces the actual Java token byte-for-byte; it is not re-signing or
secret protection. Its safe classification comes from ephemeral test provenance,
synthetic claims and the absence of private/live keys, not its representation.

Local independent reviews found no remaining blocker in the bounded signer/JWKS
and vector-test slices, including exact Java artifact comparison and product
dependency separation. The fixture can enter a Docker build stage, but its only
consumer is a `.spec.ts`; production compilation and the final runtime dependency
closure exclude the test workspace. This source-level review is not a new final
OCI scan or external release approval.

Still required: fixed service-JWT acquisition/refresh, authenticated capability
route, real fact/consumer wiring, native retained runtime, final artifact checks,
hosted cross-repository tests and runtime/UAT acceptance. None is inferred from
these local PASS results.
