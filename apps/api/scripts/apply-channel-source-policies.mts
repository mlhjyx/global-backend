#!/usr/bin/env node
/**
 * CH-8（v3.0 第 6 章 §6.3.6.5）：把渠道 manifest 派生的 source_policy 草稿落到治理表。
 *
 * `source_policy` 是 app_user 只读的治理表（2026-10-09 加固，CI 漂移门
 * `governance-table-privileges.postgres.spec.ts` 会拦住任何运行时写权限），
 * 所以本脚本必须用 **owner 连接**执行——它是派生行的唯一写入口。
 *
 * 幂等：新建行写全量（reviewStatus=APPROVED，官方开放数据域 termsStatus=REVIEWED_OK）；
 * 已存在的行只更新派生字段，**不覆盖**人工结论（termsStatus / reviewStatus / robotsStatus）。
 *
 * 用法（owner 连接串，例如 DATABASE_URL 指向 global 账号）：
 *   CHANNEL_POLICY_OWNER_DATABASE_URL=postgresql://… pnpm --filter @global/api \
 *     exec tsx scripts/apply-channel-source-policies.mts --channel <channelUuid> [--dry-run]
 */

import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { parseChannelManifest, ChannelManifestError } from '../src/channels/connector/channel-manifest';
import { deriveSourcePolicyDrafts, sourcePolicyUpsertInput } from '../src/channels/channel-source-policy';

function fail(message: string): never {
  console.error(`[apply-channel-source-policies] ${message}`);
  process.exit(1);
}

function argumentValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const databaseUrl = process.env.CHANNEL_POLICY_OWNER_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  fail('CHANNEL_POLICY_OWNER_DATABASE_URL (or DATABASE_URL) is required — this script needs the owner connection');
}

const channelId = argumentValue('--channel');
if (!channelId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(channelId)) {
  fail('usage: --channel <uuid> [--dry-run]');
}
const dryRun = process.argv.includes('--dry-run');

const db = new PrismaClient({ datasourceUrl: databaseUrl });
try {
  const channel = await db.sourceChannel.findUnique({ where: { id: channelId } });
  if (!channel) fail(`channel not found: ${channelId}`);
  if (!channel.manifest) fail(`channel ${channelId} has no manifest (legacy config channels are not derived)`);

  let manifest;
  try {
    manifest = parseChannelManifest(channel.manifest);
  } catch (error) {
    if (error instanceof ChannelManifestError) {
      fail(`stored manifest is invalid: ${error.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`);
    }
    throw error;
  }

  const drafts = deriveSourcePolicyDrafts(
    { id: channel.id, mode: channel.mode, category: channel.category },
    manifest,
  );
  if (drafts.length === 0) {
    console.log('[apply-channel-source-policies] no concrete hosts to derive (wildcard-only manifest)');
  }

  for (const draft of drafts) {
    const existing = await db.sourcePolicy.findUnique({
      where: { domain: draft.domain },
      select: { termsStatus: true, reviewStatus: true, robotsStatus: true },
    });
    if (dryRun) {
      console.log(
        `[dry-run] ${existing ? 'update' : 'create'} ${draft.domain} (${draft.sourceType}, ${draft.accessMode}, ` +
          `terms ${existing?.termsStatus ?? draft.termsStatus}, review ${existing?.reviewStatus ?? draft.reviewStatus})`,
      );
      continue;
    }
    const input = sourcePolicyUpsertInput(draft);
    await db.sourcePolicy.upsert({
      where: { domain: draft.domain },
      create: {
        id: randomUUID(),
        domain: draft.domain,
        sourceType: input.create.sourceType,
        accessMode: input.create.accessMode,
        robotsStatus: input.create.robotsStatus,
        termsStatus: input.create.termsStatus,
        personalData: input.create.personalData,
        allowedPurpose: (input.create.allowedPurpose ?? undefined) as never,
        crawlDelayMs: input.create.crawlDelayMs,
        retentionDays: input.create.retentionDays,
        reviewStatus: input.create.reviewStatus,
        owner: 'channel-derivation',
        notes: input.create.notes,
      },
      update: {
        sourceType: input.update.sourceType,
        accessMode: input.update.accessMode,
        personalData: input.update.personalData,
        allowedPurpose: (input.update.allowedPurpose ?? undefined) as never,
        crawlDelayMs: input.update.crawlDelayMs,
        retentionDays: input.update.retentionDays,
        notes: input.update.notes,
      },
    });
    console.log(
      `${existing ? 'updated' : 'created'} ${draft.domain} ` +
        `(terms ${existing?.termsStatus ?? draft.termsStatus}, review ${existing?.reviewStatus ?? draft.reviewStatus})`,
    );
  }
  console.log(`[apply-channel-source-policies] done: ${drafts.length} host(s)${dryRun ? ' (dry-run)' : ''}`);
} finally {
  await db.$disconnect();
}
