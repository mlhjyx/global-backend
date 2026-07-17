import { describe, expect, it } from 'vitest';
import {
  ASSET_KINDS,
  buildObjectKey,
  buildStagingKey,
  buildVariantObjectKey,
  extForMime,
  maxBytesForKind,
  sniffMime,
} from './object-key';

const WS = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';

describe('object-key（对象存储键布局 + 上传安全闸，02 §2 / 06 §2）', () => {
  it('canonical key = ws/{workspace}/{site}/{kind}/{hash}.{ext}', () => {
    expect(buildObjectKey(WS, SITE, 'product_image', 'abc123', 'jpg')).toBe(
      `ws/${WS}/${SITE}/product_image/abc123.jpg`,
    );
  });

  it('staging key 在 uploads/ 下且以 assetId 定位（commit 后搬运到 canonical）', () => {
    const key = buildStagingKey(WS, SITE, 'asset-1');
    expect(key).toBe(`ws/${WS}/${SITE}/uploads/asset-1`);
  });

  it('variant key 固定在 asset+recipe 专属命名空间，不能碰撞原件', () => {
    const recipeHash = 'a'.repeat(64);
    expect(
      buildVariantObjectKey(WS, SITE, ASSET, recipeHash, 'avif'),
    ).toBe(`ws/${WS}/${SITE}/variants/${ASSET}/${recipeHash}.avif`);
  });

  it('variant JPEG 使用规范 jpg 扩展名', () => {
    const recipeHash = 'b'.repeat(64);
    expect(
      buildVariantObjectKey(WS, SITE, ASSET, recipeHash, 'jpeg'),
    ).toBe(`ws/${WS}/${SITE}/variants/${ASSET}/${recipeHash}.jpg`);
  });

  it('extForMime：白名单内返回扩展名，白名单外返回 null', () => {
    expect(extForMime('image/jpeg')).toBe('jpg');
    expect(extForMime('application/pdf')).toBe('pdf');
    expect(
      extForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
    ).toBe('docx');
    expect(extForMime('application/x-msdownload')).toBeNull();
    expect(extForMime('text/html')).toBeNull(); // HTML 永不作为素材（注入面）
  });

  it('maxBytesForKind：图 20MB / 文档 50MB / 视频 500MB（06 §2）', () => {
    expect(maxBytesForKind('product_image')).toBe(20 * 1024 * 1024);
    expect(maxBytesForKind('doc')).toBe(50 * 1024 * 1024);
    expect(maxBytesForKind('video')).toBe(500 * 1024 * 1024);
  });

  it('ASSET_KINDS 与 schema 注释一致', () => {
    expect([...ASSET_KINDS]).toEqual([
      'logo',
      'product_image',
      'factory_image',
      'cert',
      'doc',
      'video',
    ]);
  });

  describe('sniffMime（魔数嗅探，不信 Content-Type）', () => {
    it('JPEG/PNG/WebP/PDF/ZIP(docx) 魔数识别', () => {
      expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('image/jpeg');
      expect(
        sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      ).toBe('image/png');
      const webp = Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.from([0, 0, 0, 0]),
        Buffer.from('WEBP'),
      ]);
      expect(sniffMime(webp)).toBe('image/webp');
      expect(sniffMime(Buffer.from('%PDF-1.7\n…'))).toBe('application/pdf');
      expect(sniffMime(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('application/zip');
    });

    it('未知魔数返回 null（调用方按 rejected 处理）', () => {
      expect(sniffMime(Buffer.from('MZ\x90\x00'))).toBeNull();
      expect(sniffMime(Buffer.alloc(0))).toBeNull();
    });
  });
});
