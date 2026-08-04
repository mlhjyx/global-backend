# AI observability development profile

Langfuse is an optional, fail-open observer for the Model Execution Runtime. It
does not provide prompts to production, choose routes, proxy model traffic, or
participate in BuildRun success. Git remains authoritative for task contracts,
schemas, prompts, and routes.

## Capacity decision

The Ubuntu development host was checked before adding the profile: 60 GiB RAM
(50 GiB available), 8 GiB swap, and more than 700 GiB free on the system disk.
That clears Langfuse's published minimums for a single development stack. The
profile remains opt-in because the web, worker, PostgreSQL, Redis, ClickHouse,
and MinIO minimums total substantial CPU and memory.

The profile uses independent containers, credentials, volumes, PostgreSQL
database/user, Redis instance, ClickHouse, and MinIO buckets. It does not reuse
the business database, Redis data, or Site Builder object bucket. Every exposed
port is loopback-only:

- Langfuse UI/API: `127.0.0.1:3002`
- Langfuse MinIO S3 endpoint: `127.0.0.1:9092`
- Langfuse MinIO console: `127.0.0.1:9093`

## Start and stop

Create the untracked secret file, replacing every placeholder:

```bash
mkdir -p .secrets
cp infra/ai-observability.env.example .secrets/ai-observability.env
```

Generate the encryption key with `openssl rand -hex 32`; generate every other
password/key independently. Then validate and start the profile:

```bash
docker compose --env-file .secrets/ai-observability.env -p global \
  -f docker-compose.yml -f infra/ai-observability.compose.yml \
  --profile ai-observability config --quiet
docker compose --env-file .secrets/ai-observability.env -p global \
  -f docker-compose.yml -f infra/ai-observability.compose.yml \
  --profile ai-observability up -d
```

Stop without deleting volumes:

```bash
docker compose --env-file .secrets/ai-observability.env -p global \
  -f docker-compose.yml -f infra/ai-observability.compose.yml \
  --profile ai-observability stop
```

Do not use `down -v`; the volumes contain the observability history.

## Data boundary and retention

Runtime export is metadata-first. Prompt and output bodies are disabled by
default; traces carry task/contract versions, digests, lengths, resolved model,
protocol, reasoning, cache outcome, hashed request/workspace/execution IDs, usage, validation, repair,
fallback, and settlement status. Restricted ContextEnvelope segments and raw
workspace content are never exported.

Only `model.runtime.state` spans are eligible for export. The collector URL is
loopback-only by default; remote export requires the explicit
`LANGFUSE_ALLOW_REMOTE_EXPORT=true` policy switch and a separate review.

Headless project initialization requests a 30-day retention period. Langfuse's
self-hosted retention automation is an Enterprise feature; without that license
the operator must treat 30 days as a policy target and use a reviewed deletion
runbook rather than silently assuming data expires. Do not configure generic S3
lifecycle deletion for the media bucket because it can break Langfuse object
references.

The application exporter must use a bounded queue and drop with a local warning
when Langfuse is unavailable. It must never block or fail a model operation.

## Version provenance

The profile pins Langfuse `4.3.1`, released 2026-08-03. Its ClickHouse version
matches the official v4 Compose baseline (`25.12`). Before any non-development
deployment, re-check the current Langfuse release notes and official Compose
file, then review migrations and resource sizing independently.
