import type { ScreenResult } from "../../sanctions/sanctions-screening.service";

/**
 * `sanctions.screen.v1` handler：确定性制裁名单筛查（复用 Qualify 第五门的匹配引擎）。
 * 只读、无工具、无模型；未启用/空索引时如实返回 not_screened（不臆造 clear）。
 */

export const SANCTIONS_SCREEN_ALGORITHM_VERSION = "sanctions-screen/v1";

export interface SanctionsScreenInput {
  readonly companyName: string;
  readonly country?: string | null;
  readonly threshold?: number;
}

export interface SanctionsScreenOutput {
  readonly status: ScreenResult["status"];
  readonly matches: ScreenResult["matches"];
  readonly listVersions: ScreenResult["listVersions"];
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
  if (threshold !== undefined && (typeof threshold !== "number" || !Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
    throw new SanctionsScreenInputError("threshold must be a number between 0 and 1");
  }
  return {
    companyName: companyName.trim(),
    ...(country !== undefined ? { country: (country as string | null) ?? null } : {}),
    ...(threshold !== undefined ? { threshold: threshold as number } : {}),
  };
}

export function runSanctionsScreen(input: unknown, screen: SanctionsScreenFn): SanctionsScreenOutput {
  const parsed = parseSanctionsScreenInput(input);
  const result = screen(parsed.companyName, parsed.country ?? null, {
    ...(parsed.threshold !== undefined ? { threshold: parsed.threshold } : {}),
  });
  if (!["clear", "potential_match", "not_screened"].includes(result.status)) {
    throw new SanctionsScreenInputError("screen returned an unknown status");
  }
  return {
    status: result.status,
    matches: result.matches.slice(0, 50),
    listVersions: result.listVersions,
    algorithmVersion: SANCTIONS_SCREEN_ALGORITHM_VERSION,
  };
}
