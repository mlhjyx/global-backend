/**
 * Rules-first trade-role classification (G3 5.4, "先规则后模型"): only a
 * decisive rule result skips the model call.
 */

export type RuleTradeRole = 'distributor' | 'manufacturer' | 'service';

export interface RuleTradeRoleResult {
  readonly role: RuleTradeRole | null;
  readonly decisive: boolean;
  readonly scores: Readonly<Record<RuleTradeRole, number>>;
}

const SIGNALS: Readonly<Record<RuleTradeRole, readonly RegExp[]>> = Object.freeze({
  distributor: [
    /gro(?:ß|ss)hand(?:el|ler)/iu, /fachhandel/iu, /h(?:ä|ae)ndler/iu, /vertriebspartner/iu,
    /\bvertrieb\b/iu, /distribut(?:or|eur|ion)/iu, /wholesal/iu, /importeur|\bimport\b/iu,
    /generalvertretung|werksvertretung/iu, /lagerprogramm|ab lager/iu, /online-?shop|\bshop\b/iu,
  ],
  manufacturer: [
    /\bhersteller\b/iu, /herstell(?:en|ung)/iu, /fertig(?:ung|en)/iu, /eigene[rn]? produktion/iu,
    /produktionsstandort|produktionswerk/iu, /made in germany/iu, /\bmanufactur/iu, /\bwerk\b/iu,
  ],
  service: [
    /reparatur/iu, /wartung/iu, /\bmontage\b/iu, /installation/iu, /sanit(?:ä|ae)r/iu, /heizung/iu,
  ],
});

const MIN_DECISIVE_SCORE = 3;
const MIN_DOMINANCE = 2;

export function classifyTradeRoleByRules(text: string): RuleTradeRoleResult {
  const scores = Object.fromEntries(
    (Object.keys(SIGNALS) as RuleTradeRole[]).map((role) => [
      role,
      SIGNALS[role].filter((pattern) => pattern.test(text)).length,
    ]),
  ) as Record<RuleTradeRole, number>;
  const ranked = (Object.keys(scores) as RuleTradeRole[]).sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0]!;
  const runnerUp = scores[ranked[1]!];
  const decisive =
    scores[top] >= MIN_DECISIVE_SCORE && scores[top] >= MIN_DOMINANCE * Math.max(runnerUp, 1);
  return { role: scores[top] > 0 ? top : null, decisive, scores };
}
