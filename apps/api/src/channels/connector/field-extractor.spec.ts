import { describe, expect, it } from 'vitest';
import { extractRecordFields, extractRecordsFromJson } from './field-extractor';
import { parseChannelManifest } from './channel-manifest';

function manifest(fieldMapping: Record<string, string>, transforms: Record<string, unknown> = {}) {
  return parseChannelManifest({
    meta: { name: 'T', version: 1, category: 'other' },
    transport: { baseUrl: 'https://api.example.com', responseType: 'json' },
    records: { itemsPath: '$.items', detail: { enabled: true } },
    fieldMapping,
    transforms,
  });
}

describe('字段抽取与清洗', () => {
  it('JSONPath 抽取 + trim + websiteHttps + emailLowercase', () => {
    const fields = extractRecordFields(
      manifest(
        { name: '$.title', website: '$.links.web', email: '$.contact.email' },
        { trim: true, websiteHttps: true, emailLowercase: true },
      ),
      { title: '  ACME  Ltd ', links: { web: 'beta.example' }, contact: { email: 'Sales@ACME.example' } },
    );
    expect(fields.name).toBe('ACME  Ltd');
    expect(fields.website).toBe('https://beta.example');
    expect(fields.email).toBe('sales@acme.example');
  });

  it('regexStrip 按序应用；坏正则在校验期拒绝而不是运行时爆栈', () => {
    const fields = extractRecordFields(
      manifest({ name: '$.title' }, { regexStrip: [{ pattern: '\\(.*\\)', flags: '' }] }),
      { title: 'ACME (Berlin)' },
    );
    expect(fields.name).toBe('ACME');
    expect(() => manifest({ name: '$.title' }, { regexStrip: [{ pattern: '(', flags: '' }] })).toThrow(/regexStrip/u);
  });

  it('超长值按列宽截断；products/keywords 数组展开为逗号串', () => {
    const fields = extractRecordFields(
      manifest({ name: '$.title', products: '$.products', keywords: '$.tags' }),
      { title: 'x'.repeat(400), products: ['pump', 'valve'], tags: ['a', 'b'] },
    );
    expect(fields.name!.length).toBe(300);
    expect(fields.products).toBe('pump, valve');
    expect(fields.keywords).toBe('a, b');
  });

  it('extractRecordsFromJson：非对象条目跳过并计数，name 为空的行丢弃', () => {
    const m = manifest({ name: '$.title' });
    const result = extractRecordsFromJson(m, { items: [{ title: 'A' }, { title: '  ' }, null, 'x', { title: 'B' }] }, 'https://api.example.com/x');
    expect(result.records.map((record) => record.fields.name)).toEqual(['A', 'B']);
    expect(result.skipped).toBe(3);
    expect(result.records[0]!.sourceUrl).toBe('https://api.example.com/x');
  });
});
