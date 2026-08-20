# Site Builder evaluation runner

This workspace is the command boundary for Site Builder evaluation and evidence
preparation. It is not part of the API or Worker product runtime.

Use `pnpm --filter @global/site-builder-eval-runner start list` to inspect the
exact command allowlist. `run <command> -- <arguments...>` dispatches only to a
listed legacy evaluation entrypoint. The runner does not relax or replace that
entrypoint's fixed-source, credential, cost, settlement, or explicit dispatch
gates.

The legacy entrypoints and `apps/api/src/site-builder/eval` remain at their
historical paths because immutable evidence binds their paths and bytes. The API
product build excludes that source tree. Commands that require its former
compiled API layout need a new successor source bundle and fresh authorization;
historical evidence is never rewritten to point at this runner.
