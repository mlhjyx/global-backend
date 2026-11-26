import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { vi } from "vitest";

/**
 * Load a feature through Vitest so this test-only branch can run before the
 * implementation branches land. Missing features fail with an actionable error.
 */
export async function loadProductExport<T extends (...args: never[]) => unknown>(
  feature: string,
  apiRelativePath: string,
  exportName: string,
): Promise<T> {
  const path = resolve(__dirname, "../../..", apiRelativePath);
  if (!existsSync(path)) {
    throw new Error(`${feature} requires the implementation at apps/api/${apiRelativePath}`);
  }
  const module = await vi.importActual<Record<string, unknown>>(path);
  const exported = module[exportName];
  if (typeof exported !== "function") {
    throw new Error(`${feature} requires the ${exportName} export from apps/api/${apiRelativePath}`);
  }
  return exported as T;
}
