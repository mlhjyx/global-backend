/**
 * R0-4 存量脱敏（一次性数据迁移，须与本 PR 代码同步在生产上线时/后跑）。
 *
 * 背景：旧 `intakeToMarkdown` 把 `businessEmail` 写进 intake KB 文档 → 进入 embedding 检索语料
 * 与 `brandProfile.kbDigest` 品牌 Prompt，违反「contact 不进品牌 Prompt」（隐私红线，与 ADR-010
 * 存储侧同源，见 06 §安全 / 09 §34 R0-4）。代码已停写（本 PR `intakeToMarkdown` 去 email 行）。
 *
 * 本脚本清存量：删除 `source=intake` 且 chunk 携带邮箱（含 '@'）的历史 KbDocument——`kb_chunk` 对
 * `kb_document` 是 `onDelete: Cascade`，删文档即连带删除其全部 chunk（旧 email chunk 随之移除，
 * 满足「证明旧 email chunk 已删」）。intake 事实的**权威副本仍在 `Site.intake`**（结构化受控区），
 * 下次 demo/refurbish build 会用**脱敏后**的 `intakeToMarkdown` 重新摄入 KB（延迟重建）。
 *
 * 幂等：无匹配即 no-op（可重放）。运行完再查 `%@%` 为 0 即证明清理成功。
 * owner 连接（跨租户平台级维护，绕 RLS——同 relay/seed 先例）。
 * 运行：cd apps/api && node --import tsx scripts/backfill-intake-kb-desensitize.mts
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

export interface DesensitizeCounts {
  scanned: number;
  deleted: number;
}

/**
 * 删除携带邮箱的存量 intake KbDocument（cascade 删 chunk）。
 * '@' 是邮箱指征——intakeToMarkdown 历史里唯一注入 '@' 的就是 `Business email:` 行；即便个别误命中，
 * 删除也仅令该 intake doc 于下次 build 脱敏重摄（自愈、无害），故宁可多删不可漏 email。
 */
export async function backfillIntakeKbDesensitize(prisma: PrismaClient): Promise<DesensitizeCounts> {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    select distinct d.id
    from kb_document d
    join kb_chunk ch on ch.document_id = d.id
    where d.source = 'intake' and ch.text like '%@%'`;
  let deleted = 0;
  for (const { id } of rows) {
    await prisma.kbDocument.delete({ where: { id } }); // onDelete: Cascade → 连带删 kb_chunk
    deleted += 1;
  }
  return { scanned: rows.length, deleted };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prisma = new PrismaClient();
  backfillIntakeKbDesensitize(prisma)
    .then((r) => console.log(`[R0-4 backfill] intake KB desensitize: scanned=${r.scanned} deleted=${r.deleted}`))
    .catch((e) => {
      console.error('[R0-4 backfill] failed:', e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
