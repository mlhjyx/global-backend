import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service';
import { createWorkspacePurgeActivities } from '../temporal/workspace-purge.activities';
import type { TemporalClient } from '../temporal/temporal.client';
import { WorkspacePurgeService } from './workspace-purge.service';

const ownerUrl = process.env.WORKSPACE_PURGE_TEST_DATABASE_URL;
const appUrl = process.env.WORKSPACE_PURGE_TEST_APP_DATABASE_URL;
if (Boolean(ownerUrl) !== Boolean(appUrl)) {
  throw new Error(
    'workspace purge tests need both WORKSPACE_PURGE_TEST_DATABASE_URL and WORKSPACE_PURGE_TEST_APP_DATABASE_URL',
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== 'postgresql:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    !url.pathname.endsWith('_test') ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error('workspace purge tests require a loopback *_test database');
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sqlState(error: unknown): string | null {
  if (
    !(error instanceof Prisma.PrismaClientKnownRequestError) ||
    error.code !== 'P2010'
  ) {
    return null;
  }
  const code = (error.meta as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : null;
}

describe.runIf(Boolean(ownerUrl && appUrl))(
  'Whole-workspace physical purge on PostgreSQL as app_user',
  { timeout: 120_000 },
  () => {
    let owner: PrismaClient;
    let app: PrismaClient;
    const wsA = randomUUID();
    const wsB = randomUUID();
    const wsEmpty = randomUUID();
    const userA = randomUUID();
    const userB = randomUUID();
    const channelId = randomUUID();
    const runNonce = randomUUID();
    const sharedLegacySha = sha256(`shared-legacy-personal-object-${runNonce}`);
    const sharedLegacyKey = `generic-operation-results/v1/final/personal-data/sha256/${sharedLegacySha.slice(0, 2)}/${sharedLegacySha}`;
    const wsAPersonalSha = sha256(`ws-a-personal-object-${runNonce}`);
    const wsAPersonalKey = `generic-operation-results/v1/final/personal-data/ws/${wsA}/sha256/${wsAPersonalSha.slice(0, 2)}/${wsAPersonalSha}`;
    const publicSha = sha256(`shared-public-org-object-${runNonce}`);
    const publicKey = `generic-operation-results/v1/final/public-organization/sha256/${publicSha.slice(0, 2)}/${publicSha}`;

    function appPrismaService(): PrismaService {
      return {
        withWorkspace: <T>(
          workspaceId: string,
          fn: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { timeout?: number },
        ) =>
          app.$transaction(
            async (tx) => {
              await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
              return fn(tx);
            },
            { timeout: options?.timeout ?? 30_000 },
          ),
      } as unknown as PrismaService;
    }

    async function seedWorkspaceFixtures(workspaceId: string, userId: string, tag: string) {
      const companyId = randomUUID();
      const docId = randomUUID();
      const icpId = randomUUID();
      const planId = randomUUID();
      const runId = randomUUID();
      const canonCompanyId = randomUUID();
      const contactId = randomUUID();
      const leadId = randomUUID();
      const supId = randomUUID();
      const siteId = randomUUID();
      const siteVersionId = randomUUID();
      const buildRunId = randomUUID();
      const releaseId = randomUUID();
      const spendId = randomUUID();
      const wireAttemptId = randomUUID();
      const exportId = randomUUID();
      const authId = randomUUID();
      const accountId = randomUUID();
      const opId = randomUUID();
      const opIdShared = randomUUID();
      const opIdPublic = randomUUID();
      const artifactId = randomUUID();
      const artifactSharedId = randomUUID();
      const artifactPublicId = randomUUID();
      const delReqId = randomUUID();
      const rawId = randomUUID();
      const identityLinkId = randomUUID();
      const fieldEvidenceId = randomUUID();
      const sanctionsId = randomUUID();
      const channelRunId = randomUUID();
      const queryKey = sha256(`query-${tag}-${workspaceId}`);
      const ackId = sha256(`ack-${tag}-${workspaceId}`);
      const contractSha = sha256(`contract-${tag}-${workspaceId}`);

      await owner.$executeRaw`
        INSERT INTO workspace (id, name, created_at, updated_at)
        VALUES (${workspaceId}::uuid, ${`WS ${tag}`}, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO company_profile (id, workspace_id, name, status, target_markets, created_at, updated_at)
        VALUES (${companyId}::uuid, ${workspaceId}::uuid, ${`Seller ${tag}`}, 'ACTIVE', ARRAY['US']::text[], now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO seller_document (id, workspace_id, company_id, uploaded_by, filename, mime, size_bytes, kind, object_key, status, created_at, updated_at)
        VALUES (${docId}::uuid, ${workspaceId}::uuid, ${companyId}::uuid, ${userId}::uuid, 'deck.pdf', 'application/pdf', 1024, 'pdf', ${`ws/${workspaceId}/doc`}, 'ready', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO icp_definition (id, workspace_id, company_id, name, status, created_at, updated_at)
        VALUES (${icpId}::uuid, ${workspaceId}::uuid, ${companyId}::uuid, ${`ICP ${tag}`}, 'ACTIVE', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO discovery_query_plan (id, workspace_id, icp_id, status, queries, created_at, updated_at)
        VALUES (${planId}::uuid, ${workspaceId}::uuid, ${icpId}::uuid, 'READY', '[]'::jsonb, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO discovery_run (id, workspace_id, plan_id, icp_id, status, materialization_contract_version, created_at)
        VALUES (${runId}::uuid, ${workspaceId}::uuid, ${planId}::uuid, ${icpId}::uuid, 'DONE', 'discovery-company-materialization/v1', now())
      `;
      await owner.$executeRaw`
        INSERT INTO canonical_company (id, workspace_id, name, status, dedupe_key, created_at, updated_at)
        VALUES (${canonCompanyId}::uuid, ${workspaceId}::uuid, ${`Buyer ${tag}`}, 'NEW', ${`domain:${tag}.test`}, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO canonical_contact (id, workspace_id, company_id, full_name, dedupe_key, created_at)
        VALUES (${contactId}::uuid, ${workspaceId}::uuid, ${canonCompanyId}::uuid, ${`Contact ${tag}`}, ${`ck-${tag}`}, now())
      `;
      await owner.$executeRaw`
        INSERT INTO lead (id, workspace_id, icp_id, canonical_company_id, status, queue, created_at, updated_at)
        VALUES (${leadId}::uuid, ${workspaceId}::uuid, ${icpId}::uuid, ${canonCompanyId}::uuid, 'QUALIFIED', 'recommended', now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO lead_outreach_draft (id, workspace_id, lead_id, version, language, subject, body, body_zh, used_facts, model)
        VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, ${leadId}::uuid, 1, 'en', 'Hello', 'Body', '正文', '["company.name"]'::jsonb, 'gpt-test')
      `;
      await owner.$executeRaw`
        INSERT INTO suppression_record (id, workspace_id, type, value, reason, protection_class)
        VALUES (${supId}::uuid, ${workspaceId}::uuid, 'email', ${`optout-${tag}@example.com`}, 'unsubscribe', 'LEGAL')
      `;
      await owner.$executeRaw`
        INSERT INTO suppression_decision (id, workspace_id, suppression_id, request_id, requested_decision, requested_reason_code, decision, reason_code, actor_id)
        VALUES (${randomUUID()}::uuid, ${workspaceId}::uuid, ${supId}::uuid, ${`req-${tag}`}, 'RELEASE_REQUESTED', 'USER_PREFERENCE_CHANGED', 'RELEASE_REQUEST_DENIED', 'LEGAL_SUPPRESSION_IMMUTABLE', ${userId})
      `;

      // Site Builder + cyclic site <-> site_version + append-only wire receipt
      await owner.$executeRaw`
        INSERT INTO site (id, workspace_id, company_profile_id, name, slug, status, intake, created_at, updated_at)
        VALUES (${siteId}::uuid, ${workspaceId}::uuid, ${companyId}::uuid, ${`Site ${tag}`}, ${`slug-${workspaceId.slice(0, 8)}`}, 'draft', '{}'::jsonb, now(), now())
      `;
      await owner.$executeRaw`
        INSERT INTO site_version (id, workspace_id, site_id, version, spec, spec_version)
        VALUES (${siteVersionId}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, 1, '{}'::jsonb, '1.0.0')
      `;
      await owner.$executeRaw`
        INSERT INTO site_build_run (id, workspace_id, site_id, status, temporal_workflow_id)
        VALUES (${buildRunId}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, 'succeeded', ${`site-refurbish-${buildRunId}`})
      `;
      const relPrefix = `sites/${siteId}/releases/${releaseId}`;
      const relManifest = JSON.stringify({
        schemaVersion: 'site-builder-release-manifest/v1',
        releaseId,
        siteId,
        siteVersionId,
        buildRunId,
        artifactPrefix: relPrefix,
        artifactDigest: contractSha,
        files: [],
      });
      await owner.$executeRaw`
        INSERT INTO site_release (
          id, workspace_id, site_id, site_version_id, build_run_id, release_number, status,
          artifact_prefix, artifact_digest, manifest, manifest_digest, producer_token, lease_until, ready_at
        ) VALUES (
          ${releaseId}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, ${siteVersionId}::uuid, ${buildRunId}::uuid,
          1, 'ready', ${relPrefix}, ${contractSha}, ${relManifest}::jsonb, ${sha256(relManifest)},
          ${randomUUID()}::uuid, now() + interval '1 hour', now()
        )
      `;
      await owner.$executeRaw`
        UPDATE site SET active_version_id = ${siteVersionId}::uuid WHERE id = ${siteId}::uuid
      `;
      await owner.$executeRaw`
        INSERT INTO site_build_budget_grant (
          id, workspace_id, site_id, build_run_id, issuer, audience, jti, schema_version, purpose, operation,
          request_sha256, token_sha256, currency, unit, cap_microusd, issued_at, not_before, expires_at
        ) VALUES (
          ${randomUUID()}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, ${buildRunId}::uuid,
          'https://issuer.test', 'global-backend:site-builder-budget', ${randomUUID()}::uuid,
          'site-builder-budget-grant/v1', 'site_builder.build_run', 'refurbish',
          ${sha256(`sbb-req-${tag}`)}, ${sha256(`sbb-tok-${tag}`)}, 'USD', 'microusd',
          1000000, now() - interval '10s', now() - interval '5s', now() + interval '60s'
        )
      `;
      await owner.$executeRaw`
        INSERT INTO site_build_budget (build_run_id, workspace_id, site_id, cap_microusd)
        VALUES (${buildRunId}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, 1000000)
      `;
      await owner.$executeRaw`
        INSERT INTO site_build_spend (id, workspace_id, site_id, build_run_id, operation_key, kind, task_id, subject, reservation_microusd)
        VALUES (${spendId}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, ${buildRunId}::uuid, ${sha256(`opk-${tag}`)}, 'model', 't1', 'sub', 100)
      `;
      await owner.$executeRaw`
        INSERT INTO site_build_provider_wire_attempt (
          id, workspace_id, site_id, build_run_id, spend_id, operation_key, physical_wire_attempt,
          derivation_key_id, settlement_request_id, settlement_nonce_sha256, resolver_id, protocol,
          requested_alias, expected_channel_id, prompt_utf8_bytes, maximum_wire_calls,
          actual_max_output_tokens, catalog_max_output_tokens, maximum_quota_points, catalog_id,
          catalog_sha256, pricing_snapshot_sha256, input_price_microunits_per_million,
          output_price_microunits_per_million, ledger_microusd_per_pricing_unit
        ) VALUES (
          ${wireAttemptId}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, ${buildRunId}::uuid, ${spendId}::uuid,
          ${sha256(`opk-${tag}`)}, 1, 'key1', ${sha256(`sreq-${tag}-${workspaceId}`).slice(0, 43)}, ${contractSha},
          'new-api-request-bound-reconciliation-v1', 'openai-responses',
          'gpt-test', 1, 100, 1, 100, 100, 100, 'cat1', ${contractSha}, ${contractSha}, 1, 1, 1000000
        )
      `;
      await owner.$executeRaw`
        INSERT INTO site_build_provider_wire_receipt (
          id, workspace_id, site_id, build_run_id, spend_id, wire_attempt_id, receipt_digest,
          alias, protocol, channel_id, quota, input_tokens, output_tokens, exact_cost_microusd,
          upstream_id_state, observed_at
        ) VALUES (
          ${randomUUID()}::uuid, ${workspaceId}::uuid, ${siteId}::uuid, ${buildRunId}::uuid, ${spendId}::uuid,
          ${wireAttemptId}::uuid, ${sha256(`rcpt-${tag}-${workspaceId}`)}, 'gpt-test', 'openai-responses', 1, 10, 5, 5, 10, 'observed', now()
        )
      `;

      // Discovery lineage + raw source immutable triggers
      await owner.$executeRaw`
        INSERT INTO execution_budget_authority (
          id, scope_key, authority_kind, workspace_id, issuer, audience, jti, token_sha256,
          schema_version, purpose, subject_type, subject_id, request_sha256, currency, unit,
          cap_microusd, runs_consumed, issued_at, not_before, expires_at, consumed_at
        ) VALUES (
          ${authId}::uuid, ${workspaceId}, 'WORKSPACE_GRANT', ${workspaceId}::uuid, 'https://issuer.test',
          'global-backend:execution-budget', ${randomUUID()}::uuid, ${sha256(`tok-${tag}`)},
          'execution-budget-grant/v1', 'contact.verify', 'contact_point', ${`sub-${tag}`},
          ${sha256(`req-${tag}`)}, 'USD', 'microusd', 1000000, 1, now() - interval '10s', now() - interval '5s', now() + interval '60s', now()
        )
      `;
      await owner.$executeRaw`
        INSERT INTO tool_budget_account (
          id, scope_key, account_key, generation, cap_cents, reserved_cents, charged_cents,
          reserved_microusd, charged_microusd, exhausted, ref_count, authority_id, authorized_cap_microusd,
          created_at, updated_at
        ) VALUES (
          ${accountId}::uuid, ${workspaceId}, ${`acct-${tag}`}, 1, 0, 0, 0, 0, 0, false, 1,
          ${authId}::uuid, 1000000, now(), now()
        )
      `;
      await owner.$executeRaw`
        INSERT INTO tool_budget_operation (
          id, scope_key, account_id, generation, operation_key, reserved_cents, amount_unit,
          reserved_microusd, observed_microusd, charged_microusd, status, created_at, settled_at
        )
        VALUES
          (${opId}::uuid, ${workspaceId}, ${accountId}::uuid, 1, ${`op1-${tag}`}, 0, 'microusd', 100, 0, 0, 'SETTLED', now(), now()),
          (${opIdShared}::uuid, ${workspaceId}, ${accountId}::uuid, 1, ${`op2-${tag}`}, 0, 'microusd', 100, 0, 0, 'SETTLED', now(), now()),
          (${opIdPublic}::uuid, ${workspaceId}, ${accountId}::uuid, 1, ${`op3-${tag}`}, 0, 'microusd', 100, 0, 0, 'SETTLED', now(), now())
      `;
      const ackUsage = { currency: 'USD', unit: 'microusd' };
      const ackJson = JSON.stringify({
        schemaVersion: 'domain-ack/v1',
        ackId,
        operationId: opId,
        operationKey: `op1-${tag}`,
        authorityId: authId,
        accountId,
        scopeKey: workspaceId,
        consumer: 'PublicWebDiscoveryProvider.mineDomain',
        domainAggregateType: 'RawSourceRecord',
        domainAckKey: contractSha,
        domainRevision: contractSha,
        resultStrategy: 'typed_projection',
        resultSchema: 'discovery-extract-company/v1',
        resultDigest: contractSha,
        artifactId: null,
        usage: ackUsage,
        costBasis: 'not_incurred',
      });
      await owner.$executeRaw`
        INSERT INTO execution_domain_ack (
          ack_id, operation_id, operation_key, authority_id, account_id, scope_key, consumer,
          domain_aggregate_type, domain_ack_key, domain_revision, result_strategy, result_schema,
          result_digest, usage, cost_basis, ack_json
        ) VALUES (
          ${ackId}, ${opId}::uuid, ${`op1-${tag}`}, ${authId}::uuid, ${accountId}::uuid, ${workspaceId},
          'PublicWebDiscoveryProvider.mineDomain', 'RawSourceRecord', ${contractSha}, ${contractSha},
          'typed_projection', 'discovery-extract-company/v1', ${contractSha},
          ${JSON.stringify(ackUsage)}::jsonb, 'not_incurred', ${ackJson}::jsonb
        )
      `;

      // Seed source_fetch/source_entity temporarily disabled via replica for raw_source_record FK, or insert minimal source_fetch/entity
      await owner.$executeRaw`
        INSERT INTO discovery_query_receipt (
          workspace_id, run_id, plan_id, authority_id, account_key, purpose, subject_type, subject_id,
          request_sha256, query_key, query_ordinal, source_class, providers, provider_count, record_count,
          accepted_count, quarantined_count, rejected_count, duplicate_count, governance_denied_count,
          usage_quantity, cost_cents, contract_sha256
        ) VALUES (
          ${workspaceId}::uuid, ${runId}::uuid, ${planId}::uuid, ${authId}::uuid,
          ${`discovery.run:discovery_run:request:${contractSha}:${contractSha}`},
          'discovery.run', 'discovery_run', ${`request:${contractSha}`}, ${contractSha}, ${queryKey}, 0,
          'public_intelligence', '[]'::jsonb, 0, 0, 0, 0, 0, 0, 0, 0, 0, ${contractSha}
        )
      `;
      await owner.$executeRaw`
        INSERT INTO discovery_query_operation_attempt (
          workspace_id, run_id, query_key, provider_key, producer_id, operation_id, scope_key,
          authority_id, account_id, operation_generation, ack_id, consumer, domain_aggregate_type,
          domain_ack_key, domain_revision, result_digest, result_schema, lineage_schema,
          provider_record_count, covered_item_count, contract_sha256
        ) VALUES (
          ${workspaceId}::uuid, ${runId}::uuid, ${queryKey}, 'public_web', 'discovery.extract_company',
          ${opId}::uuid, ${workspaceId}, ${authId}::uuid, ${accountId}::uuid, 1, ${ackId},
          'PublicWebDiscoveryProvider.mineDomain', 'RawSourceRecord', ${contractSha}, ${contractSha},
          ${contractSha}, 'discovery-extract-company/v1', 'discovery-company-result-lineage/v1',
          1, 1, ${contractSha}
        )
      `;

      await owner.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
        await tx.$executeRaw`
          INSERT INTO raw_source_record (id, workspace_id, run_id, provider_key, source_class, payload, ingest_version)
          VALUES (${rawId}::uuid, ${workspaceId}::uuid, ${runId}::uuid, 'public_web', 'public_intelligence', '{}'::jsonb, 'v1')
        `;
        await tx.$executeRaw`SET LOCAL session_replication_role = origin`;
      });

      await owner.$executeRaw`
        INSERT INTO discovery_query_attempt_item (
          id, workspace_id, run_id, query_key, provider_key, operation_id, record_index, resolution_kind,
          source_record_index, raw_record_id, raw_payload_hash, raw_ingest_status, relation_key,
          operation_subject_id, child_subject_id, relation_id, contract_sha256
        ) VALUES
          (
            ${randomUUID()}::uuid, ${workspaceId}::uuid, ${runId}::uuid, ${queryKey}, 'public_web', ${opId}::uuid,
            0, 'INSERTED', NULL, ${rawId}::uuid, ${contractSha}, 'ACCEPTED', 'discovery.raw_source_record:0',
            ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${contractSha}
          ),
          (
            ${randomUUID()}::uuid, ${workspaceId}::uuid, ${runId}::uuid, ${queryKey}, 'public_web', ${opId}::uuid,
            1, 'REUSE_BATCH', 0, ${rawId}::uuid, ${contractSha}, 'ACCEPTED', 'discovery.raw_source_record:1',
            ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${contractSha}
          )
      `;

      // Objects: shared legacy PERSONAL_DATA, public org, and (for wsA) workspace-scoped PERSONAL_DATA
      await owner.$executeRaw`
        INSERT INTO generic_operation_artifact_object (sha256, object_key, size_bytes, media_type, privacy_class, object_version_id)
        VALUES
          (${sharedLegacySha}, ${sharedLegacyKey}, 200, 'application/json', 'PERSONAL_DATA', 'ver-legacy-1'),
          (${publicSha}, ${publicKey}, 300, 'application/json', 'PUBLIC_ORGANIZATION', NULL)
        ON CONFLICT (object_key) DO NOTHING
      `;
      await owner.$executeRaw`
        INSERT INTO generic_operation_artifact_object_version (object_key, sha256, privacy_class, object_version_id)
        VALUES (${sharedLegacyKey}, ${sharedLegacySha}, 'PERSONAL_DATA', 'ver-legacy-1')
        ON CONFLICT (object_key, object_version_id) DO NOTHING
      `;

      await owner.$transaction(async (tx) => {
        if (workspaceId === wsA) {
          await tx.$executeRaw`
            INSERT INTO generic_operation_artifact_object (sha256, object_key, size_bytes, media_type, privacy_class, object_version_id)
            VALUES (${wsAPersonalSha}, ${wsAPersonalKey}, 250, 'application/json', 'PERSONAL_DATA', 'ver-wsa-1')
          `;
          await tx.$executeRaw`
            INSERT INTO generic_operation_artifact_object_version (object_key, sha256, privacy_class, object_version_id)
            VALUES (${wsAPersonalKey}, ${wsAPersonalSha}, 'PERSONAL_DATA', 'ver-wsa-1')
          `;
          await tx.$executeRaw`
            INSERT INTO generic_operation_artifact (
              id, scope_key, workspace_id, authority_id, operation_id, result_schema, object_key,
              sha256, size_bytes, media_type, privacy_class, expires_at
            ) VALUES (
              ${artifactId}::uuid, ${workspaceId}, ${workspaceId}::uuid, ${authId}::uuid, ${opId}::uuid,
              'contact-email-find-hunter/v1', ${wsAPersonalKey}, ${wsAPersonalSha}, 250, 'application/json',
              'PERSONAL_DATA', now() + interval '7 days'
            )
          `;
          await tx.$executeRaw`
            INSERT INTO generic_operation_artifact_subject (artifact_id, scope_key, workspace_id, subject_type, subject_id)
            VALUES (${artifactId}::uuid, ${workspaceId}, ${workspaceId}::uuid, 'company_profile', ${companyId}::uuid)
          `;
        }

        await tx.$executeRaw`
          INSERT INTO generic_operation_artifact (
            id, scope_key, workspace_id, authority_id, operation_id, result_schema, object_key,
            sha256, size_bytes, media_type, privacy_class, expires_at
          ) VALUES
            (
              ${artifactSharedId}::uuid, ${workspaceId}, ${workspaceId}::uuid, ${authId}::uuid, ${opIdShared}::uuid,
              'contact-email-find-hunter/v1', ${sharedLegacyKey}, ${sharedLegacySha}, 200, 'application/json',
              'PERSONAL_DATA', now() + interval '7 days'
            ),
            (
              ${artifactPublicId}::uuid, ${workspaceId}, ${workspaceId}::uuid, ${authId}::uuid, ${opIdPublic}::uuid,
              'sanctions-download/v1', ${publicKey}, ${publicSha}, 300, 'application/json',
              'PUBLIC_ORGANIZATION', now() + interval '7 days'
            )
        `;
        await tx.$executeRaw`
          INSERT INTO generic_operation_artifact_subject (artifact_id, scope_key, workspace_id, subject_type, subject_id)
          VALUES (${artifactSharedId}::uuid, ${workspaceId}, ${workspaceId}::uuid, 'company_profile', ${companyId}::uuid)
        `;
      });

      await owner.$executeRaw`
        INSERT INTO deletion_request (id, workspace_id, subject_type, subject_id, requested_by, status, updated_at)
        VALUES (${delReqId}::uuid, ${workspaceId}::uuid, 'company', ${canonCompanyId}::uuid, ${userId}::uuid, 'RECEIVED', now())
      `;
      await owner.$executeRaw`
        INSERT INTO data_export_job (id, workspace_id, requested_by, scope, format, status, object_key)
        VALUES (${exportId}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'leads', 'csv', 'ready', ${`ws/${workspaceId}/exports/${exportId}.csv`})
      `;
      await owner.$executeRaw`
        INSERT INTO url_content_cache (workspace_id, url_hash, url, content_hash, markdown, fetched_at, expires_at)
        VALUES (${workspaceId}::uuid, ${contractSha}, 'https://example.com', ${contractSha}, '# hi', now(), now() + interval '1 day')
      `;
      await owner.$executeRaw`
        INSERT INTO identity_link (id, workspace_id, canonical_type, canonical_id, raw_record_id, match_rule, confidence)
        VALUES (${identityLinkId}::uuid, ${workspaceId}::uuid, 'company', ${canonCompanyId}::uuid, ${rawId}::uuid, 'domain_exact', 1.0)
      `;
      await owner.$executeRaw`
        INSERT INTO field_evidence (id, workspace_id, entity_type, entity_id, field, value, provider_key, raw_record_id, license, data_class)
        VALUES (${fieldEvidenceId}::uuid, ${workspaceId}::uuid, 'company', ${canonCompanyId}::uuid, 'name', ${JSON.stringify(`Buyer ${tag}`)}::jsonb, 'public_web', ${rawId}::uuid, 'public', 'green')
      `;
      await owner.$executeRaw`
        INSERT INTO sanctions_screening_result (id, workspace_id, canonical_company_id, screened_name, status, matches, list_versions, updated_at)
        VALUES (${sanctionsId}::uuid, ${workspaceId}::uuid, ${canonCompanyId}::uuid, ${`Buyer ${tag}`}, 'clear', '[]'::jsonb, '{}'::jsonb, now())
      `;
      await owner.$executeRaw`
        INSERT INTO source_channel (id, name, mode, category, config, updated_at)
        VALUES (${channelId}::uuid, ${`purge-test-channel-${runNonce}`}, 'api', 'directory', '{}'::jsonb, now())
        ON CONFLICT (id) DO NOTHING
      `;
      await owner.$executeRaw`
        INSERT INTO source_channel_run (id, channel_id, triggered_by_workspace_id, status)
        VALUES (${channelRunId}::uuid, ${channelId}::uuid, ${workspaceId}::uuid, 'SUCCEEDED')
      `;

      return { companyId, docId, icpId, runId, siteId, releaseId, relPrefix, delReqId, exportId, rawId, channelRunId };
    }

    beforeAll(async () => {
      owner = new PrismaClient({ datasources: { db: { url: ownerUrl } } });
      app = new PrismaClient({ datasources: { db: { url: appUrl } } });
    });

    afterAll(async () => {
      if (owner) {
        await owner.$executeRaw`DELETE FROM source_channel WHERE id = ${channelId}::uuid`;
        await owner.$executeRaw`DELETE FROM workspace_purge_receipt WHERE workspace_id IN (${wsA}::uuid, ${wsB}::uuid, ${wsEmpty}::uuid)`;
        await owner.$executeRaw`
          DO $$
          DECLARE r RECORD;
          BEGIN
            PERFORM set_config('app.workspace_purge_nonce', '', true);
          END $$
        `;
      }
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    });

    it('enforces app_user privileges and standalone immutability triggers before & after migration', async () => {
      const privs = await owner.$queryRaw<
        Array<{ rcpt_sel: boolean; rcpt_ins: boolean; fence_sel: boolean; rpc_exec: boolean }>
      >`
        SELECT
          has_table_privilege('app_user', 'public.workspace_purge_receipt', 'SELECT') AS rcpt_sel,
          has_table_privilege('app_user', 'public.workspace_purge_receipt', 'INSERT') AS rcpt_ins,
          has_table_privilege('app_user', 'public.workspace_purge_tx_fence', 'SELECT') AS fence_sel,
          has_function_privilege('app_user', 'public.purge_workspace_tenant_data_v1(uuid)', 'EXECUTE') AS rpc_exec
      `;
      expect(privs[0]).toEqual({
        rcpt_sel: true,
        rcpt_ins: false,
        fence_sel: false,
        rpc_exec: true,
      });

      // Standalone RPC call without workspace context fails with 42501
      let unsetState: string | null = null;
      try {
        await app.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT * FROM public.begin_workspace_purge_v1(${wsA}::uuid, 'k1'::varchar, NULL::uuid)`;
        });
      } catch (err) {
        unsetState = sqlState(err);
      }
      expect(unsetState).toBe('42501');
    });

    it('purges wsA completely across all workspace tables + triggers while keeping wsB, shared legacy objects, and non-PII receipt intact', async () => {
      const fixA = await seedWorkspaceFixtures(wsA, userA, 'alpha');
      const fixB = await seedWorkspaceFixtures(wsB, userB, 'beta');

      // Verify standalone DELETE on immutable tables still rejects even as owner
      await expect(
        owner.$executeRaw`DELETE FROM raw_source_record WHERE id = ${fixA.rawId}::uuid`,
      ).rejects.toThrow(/physical deletion is forbidden/);
      await expect(
        owner.$executeRaw`DELETE FROM discovery_query_receipt WHERE workspace_id = ${wsA}::uuid`,
      ).rejects.toThrow(/DISCOVERY_QUERY_LINEAGE_IMMUTABLE/);
      await expect(
        owner.$executeRaw`UPDATE discovery_query_receipt SET record_count = 1 WHERE workspace_id = ${wsA}::uuid`,
      ).rejects.toThrow(/DISCOVERY_QUERY_LINEAGE_IMMUTABLE/);
      await expect(
        owner.$executeRaw`DELETE FROM site_build_provider_wire_receipt WHERE workspace_id = ${wsA}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        owner.$executeRaw`UPDATE site_build_provider_wire_receipt SET quota = 99 WHERE workspace_id = ${wsA}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        owner.$executeRaw`DELETE FROM workspace WHERE id = ${wsA}::uuid`,
      ).rejects.toThrow(/Workspace deletion requires explicit Site/);

      const startedWorkflows: Array<{ workflowId: string; args: unknown[] }> = [];
      const mockTemporal = {
        client: {
          workflow: {
            start: vi.fn(async (_name: string, opts: { workflowId: string; args: unknown[] }) => {
              startedWorkflows.push({ workflowId: opts.workflowId, args: opts.args });
            }),
            getHandle: () => ({ cancel: vi.fn(async () => undefined) }),
          },
        },
        reconnect: async () => true,
      } as unknown as TemporalClient;

      const prismaSvc = appPrismaService();
      const service = new WorkspacePurgeService(prismaSvc, mockTemporal);
      const began = await service.requestPurge(wsA, {
        idempotencyKey: 'purge-alpha-1',
        requestedBy: userA,
        campaignPlanJobIds: ['50000000-0000-4000-8000-000000000005'],
      });
      expect(began.status).toBe('PENDING');
      expect(startedWorkflows[0]?.workflowId).toBe(`workspace-purge-${wsA}`);

      const cancelledIds: string[] = [];
      const erasedPersonal: unknown[] = [];
      const deletedPrefixes: Array<{ bucket: string; prefix: string }> = [];
      const acts = createWorkspacePurgeActivities({
        prisma: prismaSvc,
        siteBuilderStorage: {
          deletePrefix: async (prefix) => {
            deletedPrefixes.push({ bucket: 'site-builder', prefix });
            return 2;
          },
        },
        sellerDocumentsStorage: {
          deletePrefix: async (prefix) => {
            deletedPrefixes.push({ bucket: 'seller-documents', prefix });
            return 3;
          },
        },
        personalArtifactCleanupPort: {
          eraseFinalObject: async (arg) => {
            erasedPersonal.push(arg);
            return 'DELETED';
          },
        },
        temporal: {
          client: {
            workflow: {
              getHandle: (id: string) => ({
                cancel: async () => {
                  cancelledIds.push(id);
                },
              }),
            },
          },
          reconnect: async () => true,
        },
        redisPurger: async () => 2,
      });

      expect(
        await acts.markWorkspacePurgeRunning({
          workspaceId: wsA,
          campaignPlanJobIds: ['50000000-0000-4000-8000-000000000005'],
        }),
      ).toBe(true);

      const targets = await acts.snapshotWorkspacePurgeTargets({
        workspaceId: wsA,
        campaignPlanJobIds: ['50000000-0000-4000-8000-000000000005'],
      });
      expect(targets.workflowIds).toEqual(
        expect.arrayContaining([
          `understanding-${fixA.companyId}`,
          `discovery-${fixA.runId}`,
          `qualify-${fixA.icpId}`,
          `deletion-${fixA.delReqId}`,
          `seller-document-${fixA.docId}`,
          `data-export-${fixA.exportId}`,
          'campaign-plan-50000000-0000-4000-8000-000000000005',
        ]),
      );

      const wfCancelled = await acts.cancelWorkspaceWorkflows({
        workspaceId: wsA,
        workflowIds: targets.workflowIds,
      });
      expect(wfCancelled).toBe(targets.workflowIds.length);
      expect(cancelledIds.length).toBe(targets.workflowIds.length);

      const dbRes = await acts.purgeWorkspaceDatabase({ workspaceId: wsA });
      expect(dbRes.dbRowsDeleted.workspace).toBe(1);
      expect(dbRes.dbRowsDeleted.raw_source_record).toBe(1);
      expect(dbRes.dbRowsDeleted.identity_link).toBe(1);
      expect(dbRes.dbRowsDeleted.field_evidence).toBe(1);
      expect(dbRes.dbRowsDeleted.sanctions_screening_result).toBe(1);
      expect(dbRes.dbRowsDeleted.discovery_query_attempt_item).toBe(2);
      expect(dbRes.dbRowsDeleted.site_build_provider_wire_receipt).toBe(1);
      expect(dbRes.dbRowsDeleted.data_export_job).toBe(1);

      // Only wsA's unreferenced PERSONAL_DATA object is scheduled for S3 erasure;
      // the shared legacy PERSONAL_DATA object still referenced by wsB MUST NOT be erased!
      expect(dbRes.personalObjectsToErase).toEqual([
        {
          objectKey: wsAPersonalKey,
          sha256: wsAPersonalSha,
          versionId: 'ver-wsa-1',
          objectScope: 'workspace',
        },
      ]);

      const storageRes = await acts.purgeWorkspaceStorage({
        workspaceId: wsA,
        siteIds: targets.siteIds,
        legacyReleasePrefixes: targets.legacyReleasePrefixes,
        exportObjectKeys: targets.exportObjectKeys,
        personalObjects: dbRes.personalObjectsToErase,
      });
      expect(storageRes).toEqual({
        sellerDocuments: 3,
        siteBuilder: 6,
        operationArtifacts: 1,
      });
      expect(deletedPrefixes).toEqual(
        expect.arrayContaining([
          { bucket: 'seller-documents', prefix: `ws/${wsA}/` },
          { bucket: 'site-builder', prefix: `ws/${wsA}/` },
          { bucket: 'site-builder', prefix: `sites/${fixA.siteId}/` },
          { bucket: 'site-builder', prefix: `${fixA.relPrefix}/` },
        ]),
      );
      expect(erasedPersonal).toHaveLength(1);

      const completed = await acts.completeWorkspacePurge({
        workspaceId: wsA,
        dbRowsDeleted: dbRes.dbRowsDeleted,
        minioObjectsDeleted: storageRes,
        redisKeysDeleted: 2,
        temporalWorkflowsCancelled: wfCancelled,
      });
      expect(completed.status).toBe('COMPLETED');
      expect(completed.redisKeysDeleted).toBe(2);

      // Verify 0 rows remain for wsA in EVERY table with workspace_id, scope_key, or triggered_by_workspace_id (except workspace_purge_receipt)
      const wsTables = await owner.$queryRaw<Array<{ table_name: string; col_name: string }>>`
        SELECT c.table_name, c.column_name AS col_name
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.column_name IN ('workspace_id', 'scope_key', 'triggered_by_workspace_id')
          AND c.table_name NOT IN ('workspace_purge_receipt', 'workspace_purge_tx_fence')
        ORDER BY c.table_name, c.column_name
      `;
      const leftovers: string[] = [];
      for (const tbl of wsTables) {
        const [{ cnt }] = await owner.$queryRawUnsafe<Array<{ cnt: bigint }>>(
          tbl.col_name === 'scope_key'
            ? `SELECT count(*)::bigint AS cnt FROM public."${tbl.table_name}" WHERE "scope_key" = $1`
            : `SELECT count(*)::bigint AS cnt FROM public."${tbl.table_name}" WHERE "${tbl.col_name}" = $1::uuid`,
          wsA,
        );
        if (cnt > 0n) leftovers.push(`${tbl.table_name}.${tbl.col_name}=${cnt}`);
      }
      expect(leftovers).toEqual([]);

      // Verify wsA workspace row is gone, receipt survives, and wsB + shared objects + source_channel_run rows survive intact!
      const [wsACount] = await owner.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT count(*)::bigint AS cnt FROM workspace WHERE id = ${wsA}::uuid
      `;
      const [wsBCount] = await owner.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT count(*)::bigint AS cnt FROM workspace WHERE id = ${wsB}::uuid
      `;
      const [wsBIdentityCount] = await owner.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT count(*)::bigint AS cnt FROM identity_link WHERE workspace_id = ${wsB}::uuid
      `;
      const [wsBFieldEvidenceCount] = await owner.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT count(*)::bigint AS cnt FROM field_evidence WHERE workspace_id = ${wsB}::uuid
      `;
      const [wsBSanctionsCount] = await owner.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT count(*)::bigint AS cnt FROM sanctions_screening_result WHERE workspace_id = ${wsB}::uuid
      `;
      const [channelRunA] = await owner.$queryRaw<Array<{ triggered_by_workspace_id: string | null }>>`
        SELECT triggered_by_workspace_id FROM source_channel_run WHERE id = ${fixA.channelRunId}::uuid
      `;
      const [channelRunB] = await owner.$queryRaw<Array<{ triggered_by_workspace_id: string | null }>>`
        SELECT triggered_by_workspace_id FROM source_channel_run WHERE id = ${fixB.channelRunId}::uuid
      `;
      const [sharedObjCount] = await owner.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT count(*)::bigint AS cnt FROM generic_operation_artifact_object
        WHERE object_key IN (${sharedLegacyKey}, ${publicKey})
      `;
      const [wsAObjCount] = await owner.$queryRaw<Array<{ cnt: bigint }>>`
        SELECT count(*)::bigint AS cnt FROM generic_operation_artifact_object
        WHERE object_key = ${wsAPersonalKey}
      `;
      expect(wsACount?.cnt).toBe(0n);
      expect(wsBCount?.cnt).toBe(1n);
      expect(wsBIdentityCount?.cnt).toBe(1n);
      expect(wsBFieldEvidenceCount?.cnt).toBe(1n);
      expect(wsBSanctionsCount?.cnt).toBe(1n);
      expect(channelRunA?.triggered_by_workspace_id).toBeNull();
      expect(channelRunB?.triggered_by_workspace_id).toBe(wsB);
      expect(sharedObjCount?.cnt).toBe(2n);
      expect(wsAObjCount?.cnt).toBe(0n);

      // Receipt readable via WorkspacePurgeService.getReceipt (withWorkspace RLS) & idempotent POST
      const readBack = await service.getReceipt(wsA);
      expect(readBack.status).toBe('COMPLETED');
      const idempotentReplay = await service.requestPurge(wsA, {
        idempotencyKey: 'purge-alpha-retry',
      });
      expect(idempotentReplay.status).toBe('COMPLETED');
      expect(idempotentReplay.idempotencyKey).toBe('purge-alpha-1');

      // Missing global_dev.workspace row (e.g. gain_saas-only workspace) completes cleanly as no-op DB delete
      await service.requestPurge(wsEmpty, { idempotencyKey: 'empty-ws-1' });
      await acts.markWorkspacePurgeRunning({ workspaceId: wsEmpty });
      const emptyDb = await acts.purgeWorkspaceDatabase({ workspaceId: wsEmpty });
      expect(emptyDb.dbRowsDeleted).toEqual({});
      expect(emptyDb.personalObjectsToErase).toEqual([]);
    });
  },
);
