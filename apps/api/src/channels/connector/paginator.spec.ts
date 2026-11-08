import { describe, expect, it } from 'vitest';
import { parseChannelManifest } from './channel-manifest';
import { ChannelPaginator } from './paginator';

function manifestWith(pagination: unknown, extra: Record<string, unknown> = {}) {
  const { transport, ...rest } = extra as { transport?: Record<string, unknown> };
  return parseChannelManifest({
    meta: { name: 'P', version: 1, category: 'other' },
    transport: {
      baseUrl: 'https://api.example.com',
      responseType: 'json',
      allowedHosts: ['api.example.com'],
      ...(transport ?? {}),
    },
    records: { itemsPath: '$.items' },
    pagination,
    ...rest,
  });
}

describe('分页器（page/offset/cursor/link/none）', () => {
  it('none：只发一次请求', () => {
    const paginator = new ChannelPaginator(manifestWith({ type: 'none' }), { maxPages: 10 });
    expect(paginator.first().url).toBe('https://api.example.com/');
    expect(paginator.next({ bodyText: '{"items":[1]}', recordsCount: 1 })).toBeNull();
  });

  it('page：pageParam 从 startPage 起，空页终止，maxPages 截断', () => {
    const paginator = new ChannelPaginator(
      manifestWith({ type: 'page', pageParam: 'page', startPage: 1, maxPages: 3, sizeParam: 'size', pageSize: 50 }),
      { maxPages: 10 },
    );
    const first = new URL(paginator.first().url);
    expect(first.searchParams.get('page')).toBe('1');
    expect(first.searchParams.get('size')).toBe('50');
    const second = paginator.next({ bodyText: '', recordsCount: 50 });
    expect(new URL(second!.url).searchParams.get('page')).toBe('2');
    expect(paginator.next({ bodyText: '', recordsCount: 0 })).toBeNull();
  });

  it('page：运行预算 maxPages 小于 manifest 时以预算为准', () => {
    const paginator = new ChannelPaginator(
      manifestWith({ type: 'page', pageParam: 'page', startPage: 1, maxPages: 50 }),
      { maxPages: 1 },
    );
    expect(paginator.first().url).toContain('page=1');
    expect(paginator.next({ bodyText: '', recordsCount: 10 })).toBeNull();
  });

  it('offset：满页继续，不满页终止', () => {
    const paginator = new ChannelPaginator(
      manifestWith({ type: 'offset', offsetParam: 'offset', limitParam: 'limit', pageSize: 100, maxPages: 5 }),
      { maxPages: 10 },
    );
    const first = new URL(paginator.first().url);
    expect(first.searchParams.get('offset')).toBe('0');
    expect(first.searchParams.get('limit')).toBe('100');
    const next = new URL(paginator.next({ bodyText: '', recordsCount: 100 })!.url);
    expect(next.searchParams.get('offset')).toBe('100');
    expect(paginator.next({ bodyText: '', recordsCount: 99 })).toBeNull();
  });

  it('cursor：从响应取 cursorParam；空/重复 cursor 终止', () => {
    const paginator = new ChannelPaginator(
      manifestWith({ type: 'cursor', cursorParam: 'cursor', cursorPath: '$.next', maxPages: 5 }),
      { maxPages: 10 },
    );
    expect(paginator.first().url).not.toContain('cursor=');
    const second = paginator.next({ bodyText: '{"next":"abc"}', recordsCount: 10 });
    expect(new URL(second!.url).searchParams.get('cursor')).toBe('abc');
    expect(paginator.next({ bodyText: '{"next":"abc"}', recordsCount: 10 })).toBeNull();
    expect(paginator.next({ bodyText: '{"next":""}', recordsCount: 10 })).toBeNull();
  });

  it('link：nextLinkPath 绝对 URL，跨域/非 https 拒绝', () => {
    const paginator = new ChannelPaginator(
      manifestWith({ type: 'link', nextLinkPath: '$.paging.next', maxPages: 5 }),
      { maxPages: 10 },
    );
    const next = paginator.next({ bodyText: '{"paging":{"next":"https://api.example.com/x?p=2"}}', recordsCount: 10 });
    expect(next!.url).toBe('https://api.example.com/x?p=2');
    expect(paginator.next({ bodyText: '{"paging":{"next":"https://api.example.com/x?p=2"}}', recordsCount: 10 })).toBeNull();
    expect(() =>
      paginator.next({ bodyText: '{"paging":{"next":"https://evil.example.org/x"}}', recordsCount: 10 }),
    ).toThrowError(expect.objectContaining({ code: 'CHANNEL_HOST_NOT_ALLOWED' }));
    expect(() =>
      paginator.next({ bodyText: '{"paging":{"next":"http://api.example.com/x"}}', recordsCount: 10 }),
    ).toThrowError(expect.objectContaining({ code: 'CHANNEL_EGRESS_DENIED' }));
  });

  it('queryDefaults 参与每个分页请求', () => {
    const paginator = new ChannelPaginator(
      manifestWith(
        { type: 'page', pageParam: 'page', startPage: 1, maxPages: 2 },
        { transport: { queryDefaults: { key: 'abc' } } },
      ),
      { maxPages: 10 },
    );
    expect(new URL(paginator.first().url).searchParams.get('key')).toBe('abc');
  });

  it('POST 形态 v1 不执行：构造即 CHANNEL_METHOD_UNSUPPORTED', () => {
    const manifest = manifestWith({ type: 'none' }, { transport: { method: 'POST' } });
    expect(() => new ChannelPaginator(manifest, { maxPages: 1 })).toThrowError(
      expect.objectContaining({ code: 'CHANNEL_METHOD_UNSUPPORTED' }),
    );
  });
});
