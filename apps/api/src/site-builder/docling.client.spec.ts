import { afterEach, describe, expect, it, vi } from 'vitest';
import { DoclingClient } from './docling.client';

const SAMPLE_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);

describe('DoclingClient（分页切片 / OCR / 页面图像提取）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('默认调用保持纯 md 契约；传入 pageRange/forceOcr/includePageImages 时透传完整参数并提取 PNG', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body ?? '{}')) as {
        options: Record<string, unknown>;
      };
      if (payload.options.include_images) {
        return new Response(
          JSON.stringify({
            status: 'success',
            document: {
              md_content: '',
              json_content: {
                pages: {
                  '2': { page_no: 2, image: { uri: `data:image/png;base64,${SAMPLE_PNG.toString('base64')}` } },
                  '1': { page_no: 1, image: { uri: `data:image/png;base64,${SAMPLE_PNG.toString('base64')}` } },
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          status: 'success',
          document: { md_content: '# HJT 720W\n\n效率 26.2%' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new DoclingClient();
    const basic = await client.convertToMarkdown('a.pdf', Buffer.from('%PDF-1.7'));
    expect(basic).toEqual({ markdown: '# HJT 720W\n\n效率 26.2%' });
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(firstBody.options).toEqual({ to_formats: ['md'] });

    const withImages = await client.convertToMarkdown('scan.pdf', Buffer.from('%PDF-1.7'), undefined, {
      pageRange: [1, 6],
      forceOcr: true,
      includePageImages: true,
      imagesScale: 1.0,
      allowEmptyMarkdown: true,
    });
    const secondBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(secondBody.options).toMatchObject({
      to_formats: ['md', 'json'],
      page_range: [1, 6],
      force_ocr: true,
      include_images: true,
      generate_page_images: true,
      image_export_mode: 'embedded',
      images_scale: 1,
    });
    expect(withImages.markdown).toBe('');
    expect(withImages.pageCount).toBe(2);
    expect(withImages.pageImages?.map((p) => p.pageNo)).toEqual([1, 2]);
    expect(withImages.pageImages?.[0]?.pngBytes.equals(SAMPLE_PNG)).toBe(true);
  });
});
