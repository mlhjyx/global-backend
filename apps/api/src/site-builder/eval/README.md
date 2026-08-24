# Historical Site Builder evaluation source

This directory is an evaluation-only compatibility surface. It is not a Site
Builder product runtime module and product composition roots must never import
it.

The existing TypeScript files remain at these exact paths because historical
evaluation manifests, source-bundle digests, native fee cards, runtime bindings,
and diagnostic reports bind their paths and bytes. Moving the files or rewriting
those immutable records would destroy provenance rather than migrate it.

New evaluation command discovery and dispatch belongs to
`apps/site-builder-eval-runner`. The product API build and product OCI artifact
exclude this directory. A historical fixed-source command that requires the old
compiled `apps/api/dist/site-builder/eval` layout is historical after that
exclusion; running it again requires a new successor source bundle, cost and
credential authorization, and fresh evidence. Historical manifests must not be
silently rebound to the successor.

No command in this directory or in the evaluation runner grants permission to
make a paid model call. Fixed-source verification, exact credential scope,
finite cost authorization, durable settlement, and explicit dispatch approval
remain separate gates.
