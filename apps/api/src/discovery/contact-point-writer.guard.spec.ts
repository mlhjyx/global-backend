import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P1-02 架构守卫：contact_point 只能经 `contact-point-writer.ts` 写入。
 *
 * 四态列 / legacy status 投影 / valid_since 等价约束 / catch-all 子类 / 验证事件账是**一个**
 * 不变量集合；历史上三路写入各写各的导致过分叉（RISKY 清 verifiedAt、状态与事件账不一致）。
 * 本守卫扫描 `apps/api/src/**`，任何直接的 `contactPoint.create/upsert/update/updateMany/
 * createMany/delete/deleteMany(` 或原生 SQL 写入都失败，并打印迁移指引。
 *
 * 允许：读路径（findMany/findUnique/findFirst）；DSR 经 canonical_contact 级联删除（不直接写表）。
 * 脚本（apps/api/scripts）不在扫描面内——它们是运维一次性工具，且回填脚本本就按密文批量更新。
 */

const SRC_ROOT = join(import.meta.dirname, '..');
const WRITER_FILE = 'discovery/contact-point-writer.ts';
const DIRECT_DELEGATE_WRITE =
  /contactPoint\.(create|upsert|update|updateMany|createMany|delete|deleteMany)\s*\(/gu;
const RAW_SQL_WRITE = /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?contact_point"?\b/giu;

export function findDirectContactPointWrites(relativePath: string, text: string): string[] {
  const findings: string[] = [];
  const withoutComments = text
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '');
  for (const pattern of [DIRECT_DELEGATE_WRITE, RAW_SQL_WRITE]) {
    pattern.lastIndex = 0;
    for (const match of withoutComments.matchAll(pattern)) {
      const line = withoutComments.slice(0, match.index).split('\n').length;
      findings.push(`${relativePath}:${line} → ${match[0].replace(/\s+/gu, ' ').trim()}`);
    }
  }
  return findings;
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('contact_point 写入守卫（P1-02）', () => {
  it('src 内不得出现 contact_point 直写（唯一例外：contact-point-writer.ts）', () => {
    const violations: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const relativePath = relative(SRC_ROOT, file).replace(/\\/gu, '/');
      if (relativePath === WRITER_FILE) continue;
      violations.push(...findDirectContactPointWrites(relativePath, readFileSync(file, 'utf8')));
    }
    expect(
      violations,
      `contact_point 直写必须收敛到 ${WRITER_FILE}（迁移指引：调用 upsertObservedContactPoint / ` +
        `upsertGuessedEmailPoint / setEmailPointState / linkLastVerificationEvent）：\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('守卫本身有效：直写与原生 SQL 都能被匹配器抓住（防守卫空转）', () => {
    expect(
      findDirectContactPointWrites('x.ts', 'await tx.contactPoint.upsert({ where: {} });'),
    ).toHaveLength(1);
    expect(
      findDirectContactPointWrites('x.ts', 'await tx.contactPoint.updateMany({ data: {} });'),
    ).toHaveLength(1);
    expect(
      findDirectContactPointWrites('x.ts', 'await tx.$executeRaw`UPDATE "contact_point" SET x = 1`;'),
    ).toHaveLength(1);
    // 读路径与注释里的字样不算违例。
    expect(
      findDirectContactPointWrites('x.ts', 'await tx.contactPoint.findMany({});'),
    ).toHaveLength(0);
    expect(
      findDirectContactPointWrites('x.ts', '// tx.contactPoint.update is forbidden\nconst a = 1;'),
    ).toHaveLength(0);
  });

  it('写入器自身确实承载了三类写入原语（守卫的允许清单不是空的）', () => {
    const writer = readFileSync(join(SRC_ROOT, WRITER_FILE), 'utf8');
    expect(writer).toContain('tx.contactPoint.upsert(');
    expect(writer).toContain('tx.contactPoint.update(');
  });
});
