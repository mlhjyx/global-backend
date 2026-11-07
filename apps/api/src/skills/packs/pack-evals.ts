import { canonicalDigest } from "../../model-runtime/context-engine";
import { runDeterministicEvals, type EvalRunResult } from "../evals/deterministic-executor";
import type { EvalManifest } from "../evals/eval-manifest";
import type { PackManifest } from "./pack-manifest";
import { buildStrategy } from "./pack-resolver";
import type { PackVersionRow } from "./pack-registry.store";

/**
 * Pack 的零模型评测执行器（发布门）：把某个 Pack 版本放进样本选择器上下文渲染
 * 策略简报，断言其被选中/排除、规则摘要、简报上限与内容要点。评测清单来自
 * `content/<type>/<dir>/evals/evals.json`（或 Studio 请求体），清单摘要写回执。
 */

export interface PackEvalSubject {
  readonly packKey: string;
  readonly version: string;
  readonly manifest: PackManifest;
  readonly content: string;
  readonly contentDigest: string;
}

export interface PackSelectorInput {
  readonly industries?: readonly string[];
  readonly markets?: readonly string[];
  readonly motions?: readonly string[];
}

const SELECTOR_KEYS = ["industries", "markets", "motions"] as const;

export class PackEvalInputError extends Error {
  readonly code = "PACK_EVAL_INPUT_INVALID";
}

export function parseSelectorInput(input: unknown): PackSelectorInput {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PackEvalInputError("selector input must be an object");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SELECTOR_KEYS.includes(key as (typeof SELECTOR_KEYS)[number])) {
      throw new PackEvalInputError(`unknown selector field: ${key}`);
    }
    const value = record[key];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === ""))
    ) {
      throw new PackEvalInputError(`${key} must be an array of non-empty strings`);
    }
  }
  return {
    ...(Array.isArray(record["industries"])
      ? { industries: record["industries"] as string[] }
      : {}),
    ...(Array.isArray(record["markets"]) ? { markets: record["markets"] as string[] } : {}),
    ...(Array.isArray(record["motions"]) ? { motions: record["motions"] as string[] } : {}),
  };
}

export async function runPackEvals(
  manifest: EvalManifest,
  subject: PackEvalSubject,
): Promise<EvalRunResult> {
  const versionRow: PackVersionRow = {
    id: `eval:${subject.packKey}`,
    packageId: "eval",
    version: subject.version,
    manifest: subject.manifest,
    content: subject.content,
    manifestDigest: canonicalDigest(subject.manifest),
    contentDigest: subject.contentDigest,
  };
  return runDeterministicEvals(manifest, (evalCase) => {
    const selectors = parseSelectorInput(evalCase.input);
    const resolved = buildStrategy(
      { skillKey: `pack-eval:${subject.packKey}`, ...selectors },
      [versionRow],
    );
    return {
      output: {
        brief: resolved.brief,
        descriptor: resolved.descriptor,
        rulesDigest: resolved.descriptor.rulesDigest,
        briefLength: resolved.brief.length,
        contentDigest: subject.contentDigest,
      },
    };
  });
}
