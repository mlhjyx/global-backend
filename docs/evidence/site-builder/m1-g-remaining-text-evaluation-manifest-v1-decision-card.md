# M1-g remaining text-task manifest v1 — decision record

- Status: `READY_FOR_SEPARATE_PRICE_EVIDENCE`; `dispatchAuthorization=NOT_AUTHORIZED`.
- Fixed source: `0891b374321961b8aad13c8b215985ca623a4c0c` (must remain reachable from `origin/main` before any evidence run).
- Artifact: [m1-g-remaining-text-evaluation-manifest-v1.json](m1-g-remaining-text-evaluation-manifest-v1.json), created once by the repository create-only writer.

## Frozen zero-cost scope

| Task | Executions | Maximum wire calls | Target candidates |
| --- | ---: | ---: | --- |
| `site_builder.copy` | 13 | 26 | `claude-sonnet-5`, `gpt-5.5`, `gpt-5.6-terra` |
| `site_builder.assemble` | 73 | 146 | `gpt-5.6-terra`, `gpt-5.5`, `claude-sonnet-5` |
| `site_builder.assembly_fix` | 73 | 146 | `gpt-5.6-terra`, `gpt-5.5`, `claude-sonnet-5` |
| `site_builder.qa_summarize` | 12 | 24 | `gpt-5.6-luna`, `gpt-5.4-mini`, `gpt-5.6-terra` |
| `site_builder.seo_review` | 12 | 24 | `gpt-5.6-luna`, `gpt-5.4-mini`, `gpt-5.6-terra` |
| Total | 183 | 366 | task-specific only |

This preparation did not read credentials, prices, balances, or `.env`; it made zero network/model calls and recorded zero model cost. The 7,320¢ mechanical ceiling is not a price card and is not spending authorization.

## Explicit exclusions and next gates

MiniMax, Doubao, Gemini text, image, video, route changes, promotions, and M2 publish remain out of scope. Each task still needs a separately verified OpenOx public-price card, purpose-specific finite credential, known settlement, balance/limit evidence, a new explicit cost authorization, a real-evidence PR, and a separate promotion decision. Nothing here changes the active route.
