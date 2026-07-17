import type { ServeStaticModuleOptions } from '@nestjs/serve-static';
import path from 'node:path';

export function previewStaticOptions(
  root = process.env.PREVIEW_DIR ??
    path.join(process.cwd(), '.preview', 'sites'),
): ServeStaticModuleOptions[] {
  const common = {
    serveRoot: '/preview',
    // Disable the package's catch-all sendFile route so an active-root miss reaches legacy.
    renderPath: '/__no_preview_spa_fallback__',
    serveStaticOptions: { index: ['index.html'], fallthrough: true },
  } satisfies Omit<ServeStaticModuleOptions, 'rootPath'>;
  return [
    { ...common, rootPath: path.join(root, '.active') },
    { ...common, rootPath: root },
  ];
}
