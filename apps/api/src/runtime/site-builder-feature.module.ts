import { type DynamicModule, Module } from "@nestjs/common";
import { isSiteBuilderEnabled } from "./site-builder-feature-flag";

/**
 * Runtime-gated wrapper around the frozen `SiteBuilderModule`.
 *
 * Returns a lazy `PromiseLike<DynamicModule>` so merely importing `AppModule`
 * in metadata/unit specs never kicks off an unawaited background dynamic
 * `import()` before NestJS actually boots.
 *
 * When NestJS awaits this module:
 * - `SITE_BUILDER_ENABLED=false` returns `{ imports: [] }` and never loads
 *   `site-builder.module.ts`.
 * - `SITE_BUILDER_ENABLED=true` (default) dynamically imports `SiteBuilderModule`
 *   so OpenAPI export and all existing contracts remain unchanged.
 */
@Module({})
export class SiteBuilderFeatureModule {
  static register(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<DynamicModule> {
    let pending: Promise<DynamicModule> | undefined;
    const resolveModule = (): Promise<DynamicModule> => {
      if (!pending) {
        pending = (async () => {
          if (!isSiteBuilderEnabled(env)) {
            return {
              module: SiteBuilderFeatureModule,
              imports: [],
            };
          }
          const { SiteBuilderModule } = await import("../site-builder/site-builder.module");
          return {
            module: SiteBuilderFeatureModule,
            imports: [SiteBuilderModule],
          };
        })();
      }
      return pending;
    };
    const lazyPromise: Promise<DynamicModule> = {
      [Symbol.toStringTag]: "Promise",
      then(onfulfilled, onrejected) {
        return resolveModule().then(onfulfilled, onrejected);
      },
      catch(onrejected) {
        return resolveModule().catch(onrejected);
      },
      finally(onfinally) {
        return resolveModule().finally(onfinally);
      },
    };
    return lazyPromise;
  }
}
