import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const migrationUrl = new URL(
  '../../../../packages/db/prisma/migrations/20260720100000_site_preview_release_resolver/migration.sql',
  import.meta.url,
);

describe('R1 object-backed preview routing', () => {
  it('replaces node-local static shadowing with an OpenAPI-hidden preview controller', async () => {
    const [appModule, siteBuilderModule, controller] = await Promise.all([
      readFile(new URL('../app.module.ts', import.meta.url), 'utf8'),
      readFile(new URL('./site-builder.module.ts', import.meta.url), 'utf8'),
      readFile(new URL('./site-preview.controller.ts', import.meta.url), 'utf8'),
    ]);
    expect(appModule).not.toContain('ServeStaticModule.forRoot');
    expect(siteBuilderModule).toContain('SitePreviewController');
    expect(siteBuilderModule).toContain('SitePreviewArtifactService');
    expect(controller).toContain("@Controller('preview')");
    expect(controller).toContain('@ApiExcludeController()');
  });

  it('uses one narrow SECURITY DEFINER resolver because public previews have no tenant token', async () => {
    const migration = await readFile(migrationUrl, 'utf8');
    expect(migration).toContain('resolve_site_preview_release');
    expect(migration).toMatch(/SECURITY DEFINER[\s\S]+SET search_path TO pg_catalog, public/);
    expect(migration).toMatch(/s\."active_version_id" = v\."id"/);
    expect(migration).toMatch(/r\."status" = 'ready'/);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION resolve_site_preview_release\(TEXT\) FROM PUBLIC/);
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION resolve_site_preview_release\(TEXT\) TO app_user/);
  });

  it('keeps Nest constructor dependencies as runtime values instead of erased type-only imports', async () => {
    const service = await readFile(
      new URL('./site-preview-artifact.service.ts', import.meta.url),
      'utf8',
    );
    expect(service).toContain("import { PrismaService } from '../prisma/prisma.service'");
    expect(service).toContain("import { StorageService } from './storage.service'");
    expect(service).toMatch(/private readonly storage: StorageService/);
  });
});
