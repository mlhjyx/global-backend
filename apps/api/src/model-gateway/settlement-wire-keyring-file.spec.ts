import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  chmodSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettlementDerivationKeyring } from "./settlement-wire-identity";

const hooks = vi.hoisted(() => ({
  beforeRead: undefined as undefined | (() => void),
  bytesRead: 0,
  wholeReads: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const before = () => {
    const action = hooks.beforeRead;
    hooks.beforeRead = undefined;
    action?.();
  };
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      hooks.wholeReads += 1;
      before();
      return fs.readFileSync(...args);
    },
    readSync: (...args: Parameters<typeof fs.readSync>) => {
      before();
      const count = fs.readSync(...args);
      hooks.bytesRead += count;
      return count;
    },
  };
});

const material = (key = "A") =>
  `schema=site-build-settlement-derivation-keyring/v1\nsettlement-key ACTIVE ${key.repeat(43)}\n`;
const directories: string[] = [];
function file() {
  const directory = mkdtempSync(join(tmpdir(), "settlement-keyring-race-"));
  directories.push(directory);
  const path = join(directory, "keyring");
  writeFileSync(path, material(), { mode: 0o600 });
  return path;
}
afterEach(() => {
  hooks.beforeRead = undefined;
  hooks.bytesRead = 0;
  hooks.wholeReads = 0;
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("keyring file identity throughout bounded reading", () => {
  it("rejects a same-length rewrite during reading", () => {
    const path = file();
    hooks.beforeRead = () => {
      writeFileSync(path, material("E"));
      utimesSync(path, 1_000, 1_000);
    };
    expect(() => loadSettlementDerivationKeyring(path)).toThrow(
      "SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_INVALID",
    );
  });
  it("rejects permissions widened during reading", () => {
    const path = file();
    hooks.beforeRead = () => chmodSync(path, 0o644);
    expect(() => loadSettlementDerivationKeyring(path)).toThrow(
      "SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_INVALID",
    );
  });
  it("never reads more than 4097 bytes even if the opened file grows", () => {
    const path = file();
    hooks.beforeRead = () => appendFileSync(path, Buffer.alloc(32 * 1024, 65));
    expect(() => loadSettlementDerivationKeyring(path)).toThrow(
      "SITE_BUILD_SETTLEMENT_DERIVATION_KEYRING_INVALID",
    );
    expect(hooks.wholeReads).toBe(0);
    expect(hooks.bytesRead).toBeLessThanOrEqual(4097);
  });
});
