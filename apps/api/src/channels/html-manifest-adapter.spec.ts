import { describe, expect, it } from 'vitest';
import {
  ChannelManifestError,
  parseChannelManifest,
} from './connector/channel-manifest';
import {
  buildManifestColumns,
  manifestToCrawlConfig,
} from './html-manifest-adapter';
import { crawlPageUrls } from './channel-config';

describe('html-manifest-adapter', () => {
  it('converts paginated html manifest to ChannelCrawlConfig and crawl columns', () => {
    const manifest = parseChannelManifest({
      meta: { name: 'Expo', version: 1, category: 'trade_fair' },
      transport: {
        baseUrl: 'https://expo.example',
        responseType: 'html',
        allowedHosts: ['expo.example'],
      },
      pagination: {
        type: 'page',
        pageParam: 'p',
        startPage: 1,
        maxPages: 10,
      },
      crawl: {
        list: {
          url: 'https://expo.example/list',
          itemSelector: '.card',
          itemUrlSelector: 'a::attr(href)',
        },
        detail: {
          enabled: true,
          fields: { name: 'h1', email: '.email' },
        },
      },
      governance: {
        license: 'public',
        tosUrl: 'https://expo.example/tos',
        robotsPolicy: 'A',
      },
    });

    const columns = buildManifestColumns(manifest);
    expect(columns.mode).toBe('crawl');
    expect(columns.probeRequired).toBe(true);
    expect(columns.config).toEqual({
      mode: 'crawl',
      list: {
        url: 'https://expo.example/list',
        maxPages: 10,
        itemSelector: '.card',
        itemUrlSelector: 'a::attr(href)',
        pageParam: 'p',
      },
      detail: {
        enabled: true,
        fields: { name: 'h1', email: '.email' },
      },
    });
    expect(crawlPageUrls(columns.config as never, 2)).toEqual([
      'https://expo.example/list?p=1',
      'https://expo.example/list?p=2',
    ]);
  });

  it('sets singlePage=true for 1-page static directory manifests without pageParam', () => {
    const manifest = parseChannelManifest({
      meta: { name: 'Static Expo', version: 1, category: 'trade_fair' },
      transport: { baseUrl: 'https://static.example', responseType: 'html' },
      crawl: {
        list: {
          url: 'https://static.example/exhibitors',
          itemSelector: 'div.ex-body',
          maxPages: 1,
        },
        detail: { enabled: false, fields: { name: '.company' } },
      },
    });

    const config = manifestToCrawlConfig(manifest);
    expect(config.list.singlePage).toBe(true);
    expect(crawlPageUrls(config, 5)).toEqual([
      'https://static.example/exhibitors',
    ]);
  });

  it('rejects json manifest in manifestToCrawlConfig and enforces allowedHosts on crawl.list.url', () => {
    const jsonManifest = parseChannelManifest({
      meta: { name: 'JSON API', version: 1, category: 'tender' },
      transport: { baseUrl: 'https://api.example', responseType: 'json' },
      records: { itemsPath: '$.items' },
    });
    expect(() => manifestToCrawlConfig(jsonManifest)).toThrow(
      ChannelManifestError,
    );

    expect(() =>
      parseChannelManifest({
        meta: { name: 'Bad Host', version: 1, category: 'trade_fair' },
        transport: {
          baseUrl: 'https://expo.example',
          responseType: 'html',
          allowedHosts: ['expo.example'],
        },
        crawl: {
          list: {
            url: 'https://evil.example/exhibitors',
            itemSelector: '.card',
            maxPages: 1,
          },
        },
      }),
    ).toThrow(/allowedHosts/);
  });
});
