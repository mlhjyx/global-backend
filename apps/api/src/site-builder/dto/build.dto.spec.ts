import { ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateBuildDto } from './build.dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true });

describe('CreateBuildDto HTTP boundary', () => {
  it('preserves a valid nested contract', async () => {
    await expect(
      pipe.transform(
        {
          scope: 'site',
          options: {
            stylePreset: 'modern-industrial',
            pages: ['home'],
            locales: ['en'],
          },
        },
        { type: 'body', metatype: CreateBuildDto },
      ),
    ).resolves.toMatchObject({
      scope: 'site',
      options: {
        stylePreset: 'modern-industrial',
        pages: ['home'],
        locales: ['en'],
      },
    });
  });

  it('rejects unknown option keys before whitelist can silently drop them', async () => {
    await expect(
      pipe.transform(
        { scope: 'site', options: { typoPreset: 'modern-industrial' } },
        { type: 'body', metatype: CreateBuildDto },
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      pipe.transform(
        { scope: 'site', unexpectedTopLevel: true },
        { type: 'body', metatype: CreateBuildDto },
      ),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects invalid nested preset, identifier and locale shapes', async () => {
    for (const options of [
      { stylePreset: 'unknown' },
      { pages: ['bad id'] },
      { locales: ['not_a_tag'] },
    ]) {
      await expect(
        pipe.transform(
          { scope: 'site', options },
          { type: 'body', metatype: CreateBuildDto },
        ),
      ).rejects.toMatchObject({ status: 400 });
    }
  });
});
