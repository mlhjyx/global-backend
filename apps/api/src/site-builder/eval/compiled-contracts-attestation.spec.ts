import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  assertCompiledContractsAttestationStable,
  buildCompiledContractsAttestation,
  compiledContractsRuntimeBindingFromAttestation,
  compiledContractsRuntimeBindingMatches,
  isTrustedCompiledContractsAttestation,
  readCompiledContractsRuntimeBinding,
} from "./compiled-contracts-attestation";

describe("compiled contracts fixed-commit attestation", () => {
  it("removes stale ignored output, binds the rebuilt JS tree, and detects drift", () => {
    const root = mkdtempSync(join(tmpdir(), "compiled-contracts-"));
    try {
      mkdirSync(join(root, "packages/contracts/src"), { recursive: true });
      writeFileSync(
        join(root, "packages/contracts/package.json"),
        JSON.stringify({
          name: "@global/contracts",
          scripts: { build: "node build.cjs" },
        }),
      );
      writeFileSync(
        join(root, "pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n",
      );
      writeFileSync(
        join(root, "packages/contracts/build.cjs"),
        [
          'const fs = require("node:fs");',
          'const path = require("node:path");',
          'const dist = path.join(__dirname, "dist");',
          'if (fs.existsSync(path.join(dist, "stale.js"))) process.exit(17);',
          'fs.mkdirSync(path.join(dist, "site-builder"), { recursive: true });',
          'fs.writeFileSync(path.join(dist, "index.js"), "\\"use strict\\";\\\\n");',
          'fs.writeFileSync(path.join(dist, "site-builder/model.js"), "exports.version = 1;\\\\n");',
        ].join("\n"),
      );
      writeFileSync(
        join(root, "packages/contracts/src/index.ts"),
        "export const version = 1;\n",
      );
      execFileSync("git", ["init", "-q"], { cwd: root });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], {
        cwd: root,
      });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
      execFileSync(
        "git",
        ["add", "packages/contracts", "pnpm-workspace.yaml"],
        {
          cwd: root,
        },
      );
      execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
      const fixedCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();

      mkdirSync(join(root, "packages/contracts/dist"), { recursive: true });
      writeFileSync(
        join(root, "packages/contracts/dist/stale.js"),
        "throw new Error('stale');\n",
      );
      const attestation = buildCompiledContractsAttestation({
        repositoryRoot: root,
        fixedCommitSha,
      });
      expect(existsSync(join(root, "packages/contracts/dist/stale.js"))).toBe(
        false,
      );

      expect(attestation).toMatchObject({
        fixedCommitSha,
        runtimeEntrypoint: "packages/contracts/dist/index.js",
        staleOutputRemovedBeforeBuild: true,
        suiteImportedAfterBuild: true,
      });
      expect(isTrustedCompiledContractsAttestation(attestation)).toBe(true);
      expect(Object.isFrozen(attestation.compiledArtifacts)).toBe(true);
      expect(attestation.compiledArtifacts.map(({ path }) => path)).toEqual([
        "packages/contracts/dist/index.js",
        "packages/contracts/dist/site-builder/model.js",
      ]);
      expect(() =>
        assertCompiledContractsAttestationStable(root, attestation),
      ).not.toThrow();
      const expectedRuntimeBinding =
        compiledContractsRuntimeBindingFromAttestation(attestation);
      expect(
        compiledContractsRuntimeBindingMatches(
          expectedRuntimeBinding,
          readCompiledContractsRuntimeBinding(root),
        ),
      ).toBe(true);

      writeFileSync(
        join(root, "packages/contracts/dist/index.js"),
        '"use strict"; exports.drifted = true;\n',
      );
      expect(
        compiledContractsRuntimeBindingMatches(
          expectedRuntimeBinding,
          readCompiledContractsRuntimeBinding(root),
        ),
      ).toBe(false);
      expect(() =>
        assertCompiledContractsAttestationStable(root, attestation),
      ).toThrow("compiled contracts drifted during suite preparation");
      expect(() =>
        assertCompiledContractsAttestationStable(root, {
          ...attestation,
        }),
      ).toThrow("not builder-trusted");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
