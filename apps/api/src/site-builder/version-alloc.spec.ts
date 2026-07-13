import { describe, expect, it } from 'vitest';
import { allocateNextSiteVersion } from './version-alloc';

function fakeTx(versions: number[]) {
  return {
    siteVersion: {
      aggregate: async (_args: { where: { siteId: string } }) => ({
        _max: { version: versions.length ? Math.max(...versions) : null },
      }),
    },
  };
}

describe('allocateNextSiteVersion（09 §2.1：修 M0 count+1 并发撞 @@unique(siteId,version) 雷）', () => {
  it('空站点 → 1', async () => {
    expect(await allocateNextSiteVersion(fakeTx([]) as never, 'site-1')).toBe(1);
  });

  it('版本序列有空洞 [1,3]（count=2）→ 4 而非 3（max+1 语义；count+1 会重发已存在的 3）', async () => {
    expect(await allocateNextSiteVersion(fakeTx([1, 3]) as never, 'site-1')).toBe(4);
  });

  it('连续序列 [1,2,3] → 4', async () => {
    expect(await allocateNextSiteVersion(fakeTx([1, 2, 3]) as never, 'site-1')).toBe(4);
  });
});
