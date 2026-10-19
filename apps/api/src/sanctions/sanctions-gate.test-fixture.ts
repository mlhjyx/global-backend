import type { ScreenMatch } from "./sanctions-matcher";
import type { ScreenResult } from "./sanctions-screening.service";

/**
 * 第五门的同一张真值表：qualify 的 sanctions_hold、accept（decide）的硬拦与周报导出的拦截，
 * 对每一种「这次 live 筛查 × 库里的筛查记录」组合都必须给出同一个答案（#665）。三处的 spec 都跑这张表。
 */
export const MATCH_E1: ScreenMatch = {
  externalId: "e-1",
  sourceKey: "ofac_sdn",
  matchedName: "PUMPEN HANDEL",
  aliasQuality: "primary",
  score: 0.9,
  nameScore: 0.9,
  entityCountry: null,
  countryMatch: "unknown",
  listVersion: "2026-10-19",
};
export const MATCH_E2: ScreenMatch = {
  ...MATCH_E1,
  externalId: "e-2",
  matchedName: "PUMPEN HANDEL GROUP",
};

export type LiveCase =
  "match_cleared_entity" | "match_new_entity" | "clear" | "not_screened";
export type StoredCase =
  "none" | "open" | "cleared_false_positive" | "confirmed_true_hit";

export function liveScreen(live: LiveCase): ScreenResult {
  const listVersions = { ofac_sdn: "2026-10-19" };
  switch (live) {
    case "match_cleared_entity":
      return { status: "potential_match", matches: [MATCH_E1], listVersions };
    case "match_new_entity":
      return { status: "potential_match", matches: [MATCH_E2], listVersions };
    case "clear":
      return { status: "clear", matches: [], listVersions };
    case "not_screened":
      return { status: "not_screened", matches: [], listVersions: {} };
  }
}

/** 库里的记录：都是对实体 e-1 的命中，复核态不同。 */
export function storedScreening(stored: StoredCase): {
  status: string;
  reviewState: string;
  matches: ScreenMatch[];
  listVersions: Record<string, string>;
} | null {
  if (stored === "none") return null;
  return {
    status: "potential_match",
    reviewState: stored,
    matches: [MATCH_E1],
    listVersions: { ofac_sdn: "2026-10-19" },
  };
}

const BLOCKS: Record<LiveCase, Record<StoredCase, boolean>> = {
  // live 命中：只有「库里已清白、这次命中都在已清范围内」放行。
  match_cleared_entity: {
    none: true,
    open: true,
    cleared_false_positive: false,
    confirmed_true_hit: true,
  },
  // live 出现新实体：一律拦（已清白的也重开）。
  match_new_entity: {
    none: true,
    open: true,
    cleared_false_positive: true,
    confirmed_true_hit: true,
  },
  // live 无命中：库里未清白（open / confirmed）就拦，命中只由人关闭。
  clear: {
    none: false,
    open: true,
    cleared_false_positive: false,
    confirmed_true_hit: true,
  },
  not_screened: {
    none: false,
    open: true,
    cleared_false_positive: false,
    confirmed_true_hit: true,
  },
};

export const SANCTIONS_GATE_CASES: Array<{
  live: LiveCase;
  stored: StoredCase;
  blocks: boolean;
}> = (Object.keys(BLOCKS) as LiveCase[]).flatMap((live) =>
  (Object.keys(BLOCKS[live]) as StoredCase[]).map((stored) => ({
    live,
    stored,
    blocks: BLOCKS[live][stored],
  })),
);
