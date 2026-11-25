import { describe, expect, it } from 'vitest';
import { fuseSearchEngineHits } from './cross-source-fusion';

describe('cross-source-fusion (L0 多引擎 RRF 共识排序)', () => {
  it('单引擎保持原始顺序并去重', () => {
    const out = fuseSearchEngineHits([
      {
        source: 'searxng',
        hits: [
          { url: 'https://a.de/', title: 'A' },
          { url: 'https://b.de/', title: 'B' },
          { url: 'https://a.de/', title: 'A dup' },
        ],
      },
    ]);
    expect(out.map((h) => h.url)).toEqual(['https://a.de/', 'https://b.de/']);
  });

  it('多引擎共同命中的真实企业自动排到单引擎结果前面', () => {
    const out = fuseSearchEngineHits([
      {
        source: 'searxng',
        hits: [
          { url: 'https://noisy-blog.de/post', title: 'Blog' },
          { url: 'https://real-epc.de/', title: 'Real EPC GmbH' },
        ],
      },
      {
        source: 'serper',
        hits: [
          { url: 'https://other-only.de/', title: 'Other' },
          { url: 'https://real-epc.de/', title: 'Real EPC GmbH' },
        ],
      },
      {
        source: 'brave',
        hits: [
          { url: 'https://real-epc.de/about', title: 'About Real EPC' },
        ],
      },
    ]);
    expect(out[0]?.url).toBe('https://real-epc.de/');
  });
});
