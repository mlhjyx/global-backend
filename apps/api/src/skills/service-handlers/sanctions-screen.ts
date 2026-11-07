import { normForMatch } from "../../discovery/name-match";
import type { ScreenResult } from "../../sanctions/sanctions-screening.service";

/**
 * `sanctions.screen.v1` handler：确定性制裁名单筛查（复用 Qualify 第五门的匹配引擎）。
 * 只读、无工具、无模型；未启用/空索引时如实返回 not_screened（不臆造 clear）。
 * 名字归一化后没有任何可比较 token（纯符号/空白）时不进行筛查并返回 not_screened——
 * 否则匹配器会因「无可比 token」返回零命中，被误读成「已筛查且清白」。
 */

export const SANCTIONS_SCREEN_ALGORITHM_VERSION = "sanctions-screen/v1";
export const SANCTIONS_MATCHES_LIMIT = 50;

export interface SanctionsScreenInput {
  readonly companyName: string;
  readonly country?: string | null;
  readonly threshold?: number;
}

export interface SanctionsScreenOutput {
  readonly status: ScreenResult["status"];
  readonly matches: ScreenResult["matches"];
  readonly listVersions: ScreenResult["listVersions"];
  /** 命中超过 50 条时被截断（`matches` 只保留展示分最高的前 50 条）。 */
  readonly truncated: boolean;
  readonly algorithmVersion: typeof SANCTIONS_SCREEN_ALGORITHM_VERSION;
}

export type SanctionsScreenFn = (
  companyName: string,
  country: string | null,
  opts?: { threshold?: number },
) => ScreenResult;

export class SanctionsScreenInputError extends Error {
  readonly code = "SANCTIONS_SCREEN_INPUT_INVALID";
}

/** 匹配引擎返回了闭集之外的状态：内部不变量被破坏（不是调用方输入错误）。 */
export class SanctionsScreenResultError extends Error {
  readonly code = "SANCTIONS_SCREEN_RESULT_INVALID";
}

export function parseSanctionsScreenInput(input: unknown): SanctionsScreenInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SanctionsScreenInputError("input must be an object");
  }
  const record = input as Record<string, unknown>;
  const companyName = record["companyName"];
  if (typeof companyName !== "string" || companyName.trim() === "" || companyName.length > 500) {
    throw new SanctionsScreenInputError("companyName must be a non-empty string (<=500 chars)");
  }
  const country = record["country"];
  if (country !== undefined && country !== null && (typeof country !== "string" || country.length > 120)) {
    throw new SanctionsScreenInputError("country must be a string or null");
  }
  const threshold = record["threshold"];
  // 与引擎 envThreshold 同口径：0 会被匹配器当作「全库皆候选」，只允许 (0, 1]。
  if (
    threshold !== undefined &&
    (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)
  ) {
    throw new SanctionsScreenInputError("threshold must be a number in (0, 1]");
  }
  return {
    companyName: companyName.trim(),
    ...(country !== undefined ? { country: (country as string | null) ?? null } : {}),
    ...(threshold !== undefined ? { threshold: threshold as number } : {}),
  };
}

export function runSanctionsScreen(input: unknown, screen: SanctionsScreenFn): SanctionsScreenOutput {
  const parsed = parseSanctionsScreenInput(input);
  if (normForMatch(parsed.companyName).trim() === "") {
    return {
      status: "not_screened",
      matches: [],
      listVersions: {},
      truncated: false,
      algorithmVersion: SANCTIONS_SCREEN_ALGORITHM_VERSION,
    };
  }
  const result = screen(parsed.companyName, parsed.country ?? null, {
    ...(parsed.threshold !== undefined ? { threshold: parsed.threshold } : {}),
  });
  if (!["clear", "potential_match", "not_screened"].includes(result.status)) {
    throw new SanctionsScreenResultError("screen returned an unknown status");
  }
  return {
    status: result.status,
    matches: result.matches.slice(0, SANCTIONS_MATCHES_LIMIT),
    listVersions: result.listVersions,
    truncated: result.matches.length > SANCTIONS_MATCHES_LIMIT,
    algorithmVersion: SANCTIONS_SCREEN_ALGORITHM_VERSION,
  };
}
