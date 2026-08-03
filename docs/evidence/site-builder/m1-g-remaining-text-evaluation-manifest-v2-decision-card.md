# M1-g remaining text-task manifest v2 — decision record

- Status: `READY_FOR_SEPARATE_PRICE_EVIDENCE`; `dispatchAuthorization=NOT_AUTHORIZED`.
- Fixed source: `a04f60f5597762d8fde634552b3be6a8a42c8d1d` (the merged `design_spec` v6 price-evidence commit, which must remain reachable from `origin/main` before any evidence run).
- Artifact: [m1-g-remaining-text-evaluation-manifest-v2.json](m1-g-remaining-text-evaluation-manifest-v2.json), created once by the repository create-only writer.
- Manifest digest: `c10baa88044085f89e32075f4099605c53981dda57ff557a16cf8c3edaa7b87f`.

## Frozen zero-cost scope

| Task | Executions | Maximum wire calls | Target candidates |
| --- | ---: | ---: | --- |
| `site_builder.copy` | 13 | 26 | `claude-sonnet-5`, `gpt-5.5`, `gpt-5.6-terra` |
| `site_builder.assemble` | 48 | 96 | `gpt-5.6-terra`, `claude-sonnet-5` |
| `site_builder.assembly_fix` | 48 | 96 | `gpt-5.6-terra`, `claude-sonnet-5` |
| `site_builder.qa_summarize` | 12 | 24 | `gpt-5.6-luna`, `claude-sonnet-5`, `gpt-5.6-terra` |
| `site_builder.seo_review` | 12 | 24 | `gpt-5.6-luna`, `claude-sonnet-5`, `gpt-5.6-terra` |
| Total | 133 | 266 | task-specific only |

This preparation did not read credentials, prices, balances, or `.env`; it made zero network/model calls and recorded zero model cost. The 5,320¢ mechanical ceiling is neither a price card nor spending authorization.

## Explicit exclusions and next gates

MiniMax, Doubao, Gemini text, image, video, route changes, promotions, and M2 publish remain out of scope. Each task still needs a separately verified OpenOx public-price card, purpose-specific finite credential, known settlement, balance/limit evidence, a task-specific cost authorization, real-evidence PR, and a separate promotion decision. Nothing here changes the active route.
