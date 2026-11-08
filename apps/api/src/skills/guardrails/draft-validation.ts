/**
 * `outreach.sequence_draft` 的确定性硬校验（M2 步 13-1，设计 §3）。
 *
 * 两道关，全部是纯函数（无模型、无 IO）：
 * ① `prepareDraftGrounding` —— 生成前的接地检查：没有已批准的 Claim / Offering 就
 *    不产稿（`GROUNDING_REQUIRED`，设计 D-13-b）；法域与目标语言也在这里裁决。
 * ② `validateOutreachDraft` —— 生成后的稿面检查：法域页脚要素（发送方身份 + 邮寄地址 +
 *    US 退订 / DE 撤回指引）、长度上限（subject ≤90、body ≤2000）、语言一致、
 *    禁用夸大用语，以及 `groundedOn` 的每条引用必须存在且为 APPROVED。
 *
 * 违例码是闭集（eval 断言与后续 13-3 门共用）。检查顺序固定：接地检查短路在前；
 * 其余违例按 subject → body → groundedOn → 页脚 的字段顺序收集，保证同一输入结果可复现。
 */

export const OUTREACH_JURISDICTIONS = ["US", "DE"] as const;
export type OutreachJurisdiction = (typeof OUTREACH_JURISDICTIONS)[number];

export const OUTREACH_LANGUAGES = ["en", "de"] as const;
export type OutreachLanguage = (typeof OUTREACH_LANGUAGES)[number];

export const DRAFT_VIOLATION_CODES = [
  "GROUNDING_REQUIRED",
  "GROUNDING_REF_UNKNOWN",
  "GROUNDING_REF_NOT_APPROVED",
  "FOOTER_MISSING_ELEMENTS",
  "SUBJECT_TOO_LONG",
  "BODY_TOO_LONG",
  "LANGUAGE_MISMATCH",
  "EXAGGERATION_FORBIDDEN",
  "STEPS_INCONSISTENT",
  "UNSUPPORTED_JURISDICTION",
] as const;
export type DraftViolationCode = (typeof DRAFT_VIOLATION_CODES)[number];

/** 绝对化/夸大用语（中英德三语 v0 基线）；命中即拒，人工改写后才可再提交。 */
export const DRAFT_FORBIDDEN_PHRASES = [
  "guaranteed",
  "100%",
  "100 %",
  "#1",
  "no.1",
  "best in the world",
  "world's best",
  "risk-free",
  "garantiert",
  "weltweit führend",
  "risikofrei",
] as const;

export const DRAFT_LIMITS = Object.freeze({ subjectMaxChars: 90, bodyMaxChars: 2000 });

/** 禁用短语匹配（外发文本与服务层共用同一实现，避免两套 matcher 漂移）。 */
export function findForbiddenPhrases(
  text: string,
  phrases: readonly string[] = DRAFT_FORBIDDEN_PHRASES,
): string[] {
  // toLowerCase（而非 toLocaleLowerCase）：判定必须与宿主 locale 无关（tr_TR 等
  // 会把 I 折成 ı，令同稿在不同机器上判不同）。
  const haystack = text.toLowerCase();
  return phrases.filter((phrase) => haystack.includes(phrase.toLowerCase()));
}

export interface GroundedOnRef {
  readonly claimId?: string;
  readonly offeringId?: string;
  readonly evidenceUrl?: string;
}

export interface OutreachDraft {
  readonly subject: string;
  readonly body: string;
  readonly language: string;
  readonly groundedOn: readonly GroundedOnRef[];
  readonly jurisdictionFooter: string;
  readonly editorNotes?: string;
  /** v0 预留：恒为 1 步且必须与顶层 subject/body 相同（多步序列属 13.1）。 */
  readonly steps?: readonly { readonly subject: string; readonly body: string }[];
}

export interface DraftKnowledge {
  /** 已知 Claim（含非 APPROVED）——用于区分「不存在」与「存在但未批准」。 */
  readonly claims: readonly { readonly id: string; readonly status: string }[];
  /** Offering 没有审批状态列：由调用方给出该 offering 是否已批准用于外联。 */
  readonly offerings: readonly { readonly id: string; readonly approved: boolean }[];
  /** 已批准 Claim 的证据 URL（evidenceUrl 引用只能取自这里）。 */
  readonly evidenceUrls: readonly string[];
}

export interface DraftSender {
  readonly legalName: string;
  readonly postalAddress: string;
}

export interface DraftGroundingContext {
  readonly jurisdiction: string;
  /** 由联系人证据裁决的目标语言（US→en；DE→de 或 en，见设计 §3）。 */
  readonly language: string;
  readonly sender: DraftSender;
  readonly knowledge: DraftKnowledge;
}

export interface DraftViolation {
  readonly code: DraftViolationCode;
  readonly detail: string;
}

export interface DraftValidation {
  readonly ok: boolean;
  readonly issues: readonly DraftViolation[];
}

const US_EXIT_PATTERN = /unsubscribe|opt[\s-]?out/iu;
const DE_EXIT_PATTERN = /widerruf|abbestellen|austragen|abmelden/iu;

function hasApprovedGrounding(knowledge: DraftKnowledge): boolean {
  return (
    knowledge.claims.some((claim) => claim.status === "APPROVED") ||
    knowledge.offerings.some((offering) => offering.approved)
  );
}

function isKnownLanguage(value: string): value is OutreachLanguage {
  return (OUTREACH_LANGUAGES as readonly string[]).includes(value);
}

function isKnownJurisdiction(value: string): value is OutreachJurisdiction {
  return (OUTREACH_JURISDICTIONS as readonly string[]).includes(value);
}

/**
 * 生成前接地检查。不通过时调用方不得调用模型、不得产出草稿（fail-closed）。
 */
export function prepareDraftGrounding(context: DraftGroundingContext): DraftValidation {
  const issues: DraftViolation[] = [];
  if (!isKnownJurisdiction(context.jurisdiction)) {
    issues.push({
      code: "UNSUPPORTED_JURISDICTION",
      detail: `jurisdiction ${context.jurisdiction} has no footer policy (supported: ${OUTREACH_JURISDICTIONS.join(", ")})`,
    });
    return { ok: false, issues };
  }
  if (!isKnownLanguage(context.language)) {
    issues.push({
      code: "LANGUAGE_MISMATCH",
      detail: `target language ${context.language} is not supported (supported: ${OUTREACH_LANGUAGES.join(", ")})`,
    });
    return { ok: false, issues };
  }
  if (context.jurisdiction === "US" && context.language !== "en") {
    issues.push({
      code: "LANGUAGE_MISMATCH",
      detail: "US recipients require language en in v0",
    });
    return { ok: false, issues };
  }
  if (!hasApprovedGrounding(context.knowledge)) {
    issues.push({
      code: "GROUNDING_REQUIRED",
      detail: "no APPROVED claim or approved offering in the grounding input; refusing to draft",
    });
    return { ok: false, issues };
  }
  return { ok: true, issues: [] };
}

function groundedOnIssues(
  refs: readonly GroundedOnRef[],
  knowledge: DraftKnowledge,
): DraftViolation[] {
  const issues: DraftViolation[] = [];
  if (refs.length === 0) {
    issues.push({ code: "GROUNDING_REQUIRED", detail: "groundedOn must cite at least one approved fact" });
    return issues;
  }
  for (const ref of refs) {
    const keys = (["claimId", "offeringId", "evidenceUrl"] as const).filter(
      (key) => typeof ref[key] === "string" && (ref[key] as string).trim() !== "",
    );
    if (keys.length !== 1) {
      issues.push({
        code: "GROUNDING_REF_UNKNOWN",
        detail: `groundedOn entry must carry exactly one of claimId/offeringId/evidenceUrl: ${JSON.stringify(ref)}`,
      });
      continue;
    }
    const key = keys[0];
    if (key === "claimId") {
      const id = ref.claimId as string;
      const claim = knowledge.claims.find((candidate) => candidate.id === id);
      if (!claim) {
        issues.push({ code: "GROUNDING_REF_UNKNOWN", detail: `claimId ${id} does not exist in the grounding input` });
      } else if (claim.status !== "APPROVED") {
        issues.push({
          code: "GROUNDING_REF_NOT_APPROVED",
          detail: `claimId ${id} has status ${claim.status}, only APPROVED claims may be cited`,
        });
      }
      continue;
    }
    if (key === "offeringId") {
      const id = ref.offeringId as string;
      const offering = knowledge.offerings.find((candidate) => candidate.id === id);
      if (!offering) {
        issues.push({ code: "GROUNDING_REF_UNKNOWN", detail: `offeringId ${id} does not exist in the grounding input` });
      } else if (!offering.approved) {
        issues.push({ code: "GROUNDING_REF_NOT_APPROVED", detail: `offeringId ${id} is not approved for outreach` });
      }
      continue;
    }
    const url = ref.evidenceUrl as string;
    if (!knowledge.evidenceUrls.includes(url)) {
      issues.push({
        code: "GROUNDING_REF_NOT_APPROVED",
        detail: `evidenceUrl ${url} is not an approved evidence source`,
      });
    }
  }
  return issues;
}

function footerIssues(
  footer: string,
  context: DraftGroundingContext,
): DraftViolation[] {
  const missing: string[] = [];
  const haystack = footer.toLowerCase();
  if (!haystack.includes(context.sender.legalName.toLowerCase())) {
    missing.push("sender legal name");
  }
  if (!haystack.includes(context.sender.postalAddress.toLowerCase())) {
    missing.push("postal address");
  }
  const exitPattern = context.jurisdiction === "DE" ? DE_EXIT_PATTERN : US_EXIT_PATTERN;
  if (!exitPattern.test(haystack)) {
    missing.push(context.jurisdiction === "DE" ? "withdrawal/opt-out instructions (DE)" : "unsubscribe instructions (US)");
  }
  if (missing.length === 0) return [];
  return [{ code: "FOOTER_MISSING_ELEMENTS", detail: `jurisdiction footer is missing: ${missing.join(", ")}` }];
}

function exaggerationIssues(draft: OutreachDraft): DraftViolation[] {
  const stepsText = (draft.steps ?? []).map((step) => `${step.subject}\n${step.body}`).join("\n");
  const hits = findForbiddenPhrases(`${draft.subject}\n${draft.body}\n${stepsText}`);
  if (hits.length === 0) return [];
  return [{ code: "EXAGGERATION_FORBIDDEN", detail: `forbidden absolute/exaggerated phrases: ${hits.join(", ")}` }];
}

/** v0 的 steps[] 只是预留：一旦出现，必须恰为 1 步且与顶层稿面逐字相同。 */
function stepsIssues(draft: OutreachDraft): DraftViolation[] {
  if (draft.steps === undefined) return [];
  if (
    draft.steps.length !== 1 ||
    draft.steps[0].subject !== draft.subject ||
    draft.steps[0].body !== draft.body
  ) {
    return [
      {
        code: "STEPS_INCONSISTENT",
        detail: "steps[] must be exactly one step equal to the top-level subject/body in v0",
      },
    ];
  }
  return [];
}

/**
 * 生成后稿面检查。接地不可用时短路返回（不在无接地稿上继续检查）。
 */
export function validateOutreachDraft(
  draft: OutreachDraft,
  context: DraftGroundingContext,
): DraftValidation {
  const grounding = prepareDraftGrounding(context);
  if (!grounding.ok) return grounding;

  const issues: DraftViolation[] = [];
  if ([...draft.subject].length > DRAFT_LIMITS.subjectMaxChars) {
    issues.push({
      code: "SUBJECT_TOO_LONG",
      detail: `subject is ${[...draft.subject].length} chars (max ${DRAFT_LIMITS.subjectMaxChars})`,
    });
  }
  if ([...draft.body].length > DRAFT_LIMITS.bodyMaxChars) {
    issues.push({
      code: "BODY_TOO_LONG",
      detail: `body is ${[...draft.body].length} chars (max ${DRAFT_LIMITS.bodyMaxChars})`,
    });
  }
  issues.push(...exaggerationIssues(draft));
  if (draft.language !== context.language) {
    issues.push({
      code: "LANGUAGE_MISMATCH",
      detail: `draft language ${draft.language} != expected ${context.language}`,
    });
  }
  issues.push(...groundedOnIssues(draft.groundedOn, context.knowledge));
  issues.push(...stepsIssues(draft));
  issues.push(...footerIssues(draft.jurisdictionFooter, context));
  return { ok: issues.length === 0, issues };
}

export function draftViolationCodes(validation: DraftValidation): string[] {
  return validation.issues.map((issue) => issue.code);
}
