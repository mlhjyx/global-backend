# BrandProfile MODEL-1 active release evidence

This directory is the active final-code checkpoint for evidence id
`model1-brand-profile-20260719-v20`.

- `candidate-report.json`: 2 models × 6 fixtures × 2 repeats = 24/24
  accepted, SHA-256
  `76f30d38dc958e777b036a29f430963d185399b761e7de5d63f7189b303bad60`.
- `current-route-baseline-report.json`: 1 complete legacy route × 6 fixtures ×
  2 repeats = 12/12 accepted, SHA-256
  `3aa408b68978779b4a81f3696f68c761adca453e5fafa9d513bf128d41b2d69b`.
- Both reports use source bundle SHA-256
  `32c208972e999e0a382ee1cd307a06fc45505565d17066720ff513adea6f745b`
  at start and end, with no changed paths.
- Reports contain hashes, metrics, bounded rejection metadata, transport, and
  model-resolution provenance. They do not contain credentials, prompts, or
  model response bodies.

Historical evidence remains immutable and is not a promotion checkpoint:

- `model1-brand-profile-20260718-v2` retains candidate attempts 1–12 and all
  diagnostics. Attempt 12 completed 24 calls but accepted only 23 artifacts.
- `model1-brand-profile-20260719-v3` through `v12` retain incomplete matrices,
  diagnostics, and the v5 evaluation incident.
- `v13` retains a then-current 24/24 candidate plus a 7/12 failed baseline;
  later evaluator/source changes mean it is not the final-code checkpoint.
- `v14` through `v17` retain targeted baseline diagnostics. The interrupted
  v17 baseline run produced no report and is not counted as evidence.
- `v18` and `v19` retain failed baseline preflight reports.

No historical report is overwritten or reclassified by the v20 result.
