# Native Temporal publication and local artifact readback

This is a source/publication/artifact observation, **not retained deployment,
RuntimeEvidence, product UAT, Pilot or GA acceptance**. No Temporal server was
started, no retained namespace/data was changed and no model call was made.

## Published subject

- PR #520 merge: `0192faa7024c3e6762dfb4a5102b10efaa07b78f`.
- Reviewed PR head: `7a45cc88d7591de1da8d1c3eb5b021898f006303`.
- [Final required CI](https://github.com/mlhjyx/global-backend/actions/runs/34745784211): PASS, with CodeQL and independent integration review separately checked.
- [Protected native publication](https://github.com/mlhjyx/global-backend/actions/runs/34747292515): SUCCESS.
- Registry reference: `ghcr.io/mlhjyx/global-temporal-platform@sha256:a11b50e486467d167322e10c218341a57fb34384e7e591443653c5db2caccebd`.
- Publication workflow verified the exact registry subject, native publisher workflow, main source digest and hosted-runner provenance after push. The publication window is complete; this does not authorize retained adoption by itself.

## Local verification and compatibility finding

The image was pulled by digest without starting it. System GitHub CLI 2.46.0
lacks the attestation command, so it was not treated as a passing verifier and
was not replaced. An isolated official 2.100.0 CLI was downloaded with archive
SHA-256 `e4d4bb4498e8d007abe545b6568926793ace1b6447da598294a610018cb164be`.
The default Sigstore/GitHub TUF repositories were updated and verified with the
official CLI. Exact repository/workflow/source/ref/hosted-runner attestation
verification then passed; no custom root or TLS bypass was used.

Local verification output: `/var/tmp/parity-native-attestation-0192.json`,
SHA-256 `242a9de714c48f7eba545b0adecd92d29237cbf939ee92ccde388897f0d2673e`.
It contains public artifact verification material, not service tokens or customer data.

Docker 29.1.3 omits an unset `Config.Entrypoint` in inspect JSON. The original
operator verifier accepted only explicit null and therefore rejected this same
published image. The compatibility successor accepts only absent/null/empty-array
representations of no entrypoint and still requires the exact command and user;
nonempty or malformed values remain rejected. Image/config bytes are never rewritten.
The [OCI configuration contract](https://github.com/opencontainers/image-spec/blob/main/config.md)
defines optional null as equivalent to absence and Entrypoint as optional.

The successor's two-file diff passed independent review, RED for absent/empty
array and 25 focused tests. Its actual capture of the published image passed.
That is a candidate operator-verifier observation, not a claim that this new
verifier source has already been merged or that an image was rebuilt from it.

## Artifact facts

| Fact | SHA-256 |
| --- | --- |
| Source contract digest | `ac4f0771ceb976e6e3a9aaff9f2ad7f6e5ac62283fda6ac96657d0eefee9bb17` |
| Native binary | `3d06d3fa0c4e4446cf5f7485033e6f401286c0b47a00ce021a0c14eed0153b98` |
| SBOM | `e130fc3410570fcac2c57a371d3a746a412baf92fb6eb866f4e334bf5d840835` |
| Artifact manifest identity | `d0701ce6c02ed6e44a7782ddd4fff19f189e516b68894703e1b1c5d629ffd4d3` |
| Local capture receipt | `3a2d8dcf43ab944bf1573367df2b289a4ae658579c544911c8c0de208c6e43ef` |

Capture receipt: `/var/tmp/native-entrypoint-capture-Sqmk9n/receipt.json`.
The Docker-reported image ID happened to equal the registry subject digest on
this host; it is not separately asserted to be the image-config digest.
The capture only created, exported and removed a never-started container.

## Remaining gates

Merge and verify the compatibility successor before using it as the operator
baseline. Retained native Temporal provisioning, service identities/TLS,
GrowthOS producer/consumer, unambiguous Worker/lease assembly, vulnerability
scanning, current product journeys and RuntimeEvidence remain separate gates.
An SBOM inventory is not a vulnerability scan. Customer Billing/Credits remains
deferred and is not introduced by this publication.
