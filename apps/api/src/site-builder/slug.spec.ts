import { describe, expect, it } from 'vitest';
import { makeSlug, randomSlugSuffix } from './slug';

describe('makeSlug（预览子域 slug：可读前缀 + 不可枚举随机尾，06 §7）', () => {
  it('英文公司名转 kebab 前缀并拼随机尾', () => {
    expect(makeSlug('Acme Pump Co., Ltd.', () => 'ab12cd')).toBe('acme-pump-co-ltd-ab12cd');
  });

  it('无英文名时退回 site 前缀（非拉丁字符不进子域）', () => {
    expect(makeSlug(null, () => 'ab12cd')).toBe('site-ab12cd');
    expect(makeSlug('杭州泵业有限公司', () => 'xy99zz')).toBe('site-xy99zz');
  });

  it('前缀截断：整体是合法 DNS label（≤63 字符、不以连字符开头/结尾）', () => {
    const long = 'A'.repeat(200) + ' Manufacturing';
    const slug = makeSlug(long, () => 'ab12cd');
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });

  it('产物只含小写字母数字与连字符，连续分隔符折叠', () => {
    expect(makeSlug('  Foo___Bar &&& Baz  ', () => 'ab12cd')).toBe('foo-bar-baz-ab12cd');
  });

  it('randomSlugSuffix 默认 6 位且字符集 [a-z0-9]', () => {
    for (let i = 0; i < 20; i += 1) {
      expect(randomSlugSuffix()).toMatch(/^[a-z0-9]{6}$/);
    }
  });
});
