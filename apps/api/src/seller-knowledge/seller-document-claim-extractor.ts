/**
 * S2 卖方文档辅助事实抽取（构建在 S1a 强类型原句引用之上）：
 *
 * 硬边界（绝不妥协）：
 *  1. 任何候选事实（无论来自确定性规则还是可选模型建议）都必须经过
 *     `locateQuoteByteRange` + `documentClaimQuoteBytes` 服务端 UTF-8 精确字节复核；
 *     凡无法在当前分块原文字节内精确定位的幻觉/改写建议一律丢弃；
 *  2. 抽取产物只用于生成 `NEEDS_REVIEW` 草稿，绝不跳过人工审批门或 proofVersion=4；
 *  3. 行业泛化：覆盖光伏/储能/工业机电/精密制造/电子/通用 B2B 出口核心事实维度
 *     （认证、量化规格参数、产能与工艺能力、起订量、交期、出口市场、企业概况）。
 */
import {
  documentClaimQuoteBytes,
  MAX_DOCUMENT_CLAIM_QUOTE_CHARS,
  MAX_DOCUMENT_CLAIM_STATEMENT_CHARS,
  validDocumentClaimStatement,
  validDocumentClaimType,
} from '../claim/document-claim-basis';

export type AssistedDocumentClaimType =
  | 'certification'
  | 'param'
  | 'capability'
  | 'moq'
  | 'lead_time'
  | 'market'
  | 'company_fact';

export interface LocatedQuoteRange {
  readonly quote: string;
  readonly quoteStartByte: number;
  readonly quoteEndByte: number;
  readonly quoteDigest: string;
}

export interface ModelClaimSuggestion {
  readonly type: string;
  readonly statement: string;
  readonly quote: string;
  readonly confidence?: number;
}

export interface ExtractedDocumentClaimCandidate {
  readonly type: string;
  readonly statement: string;
  readonly quote: string;
  readonly quoteStartByte: number;
  readonly quoteEndByte: number;
  readonly quoteDigest: string;
  readonly confidence: number;
  readonly extractionSource: 'deterministic' | 'model_verified';
}

export interface ProposalResult {
  readonly candidates: readonly ExtractedDocumentClaimCandidate[];
  readonly droppedModelSuggestions: number;
}

const DEFAULT_MAX_CANDIDATES = 12;
const HARD_MAX_CANDIDATES = 40;
const MIN_SEGMENT_CHARS = 12;

interface PatternRule {
  readonly type: AssistedDocumentClaimType;
  readonly pattern: RegExp;
  readonly confidence: number;
}

const DETERMINISTIC_RULES: readonly PatternRule[] = Object.freeze([
  {
    type: 'certification',
    pattern:
      /\b(?:IEC\s*6\d{4}(?:-\d+)?|ISO\s*(?:9001|14001|45001|13485|27001|50001)|IATF\s*16949|T[ÜU]V(?:\s*(?:Rheinland|S[ÜU]D|Nord))?|UL\s*\d{3,4}|CE\b|RoHS|REACH|MCS|ETL|CSA|BIS|INMETRO|Tier[- ]?1|PID[- ]?free)\b|认证|通过.*标准|盐雾|氨气腐蚀/iu,
    confidence: 0.92,
  },
  {
    type: 'moq',
    pattern: /\b(?:MOQ|minimum\s+order(?:\s+quantity)?|min\.?\s*order|20GP|40HQ|FCL|LCL)\b|最小起订量|起订量/iu,
    confidence: 0.88,
  },
  {
    type: 'lead_time',
    pattern: /\b(?:lead\s*time|delivery\s*(?:time|within)|dispatch\s*within|shipment\s*within|stock\s+in\s+(?:EU|Europe|Rotterdam|Germany))\b|交期|货期|交货周期|海外仓/iu,
    confidence: 0.86,
  },
  {
    type: 'capability',
    pattern:
      /\b(?:\d+(?:\.\d+)?\s*(?:GW|MW|GWh|MWh|tons?|units?|pcs)\s*(?:\/|\s*per\s*)(?:year|yr|annum|month)|annual\s+capacity|production\s+capacity|OEM\s*\/?\s*ODM|HJT|TOPCon|N-?type|heterojunction|automated\s+production|CNC|SMT)\b|年产能|产能达|生产线|异质结|代工|定制生产/iu,
    confidence: 0.85,
  },
  {
    type: 'param',
    pattern:
      /\b(?:\d{2,4}(?:\.\d+)?\s*(?:[-–~]\s*\d{2,4}(?:\.\d+)?)?\s*(?:Wp?|kW|MW|V|kV|A|Hz|bar|MPa|mm|kg|RPM|lm\/W)|(?:efficiency|bifaciality|degradation|temperature\s+coefficient|warranty|IP6[5-9])\b[^\n]{0,40}\d+(?:\.\d+)?\s*(?:%|years?|yr|℃|°C))/iu,
    confidence: 0.84,
  },
  {
    type: 'market',
    pattern:
      /\b(?:export(?:ed|ing|s)?\s+to|serving\s+(?:over\s+)?\d+\s+countries|global\s+markets?|Europe|Germany|Italy|Spain|Brazil|LATAM|North\s+America|MENA|Middle\s+East|Southeast\s+Asia)\b|出口至|远销|覆盖.*国家|欧洲市场|拉美市场/iu,
    confidence: 0.78,
  },
  {
    type: 'company_fact',
    pattern:
      /\b(?:founded\s+in\s+(?:19|20)\d{2}|established\s+in\s+(?:19|20)\d{2}|listed\s+on|stock\s+code|headquartered\s+in|\d{2,6}\s*(?:sqm|m²|m2)\s*(?:factory|plant|facility))\b|成立于\s*(?:19|20)\d{2}|股票代码|上市公司|厂房面积|总部位于/iu,
    confidence: 0.76,
  },
]);

/** 在 chunkText UTF-8 字节流中精确定位 verbatim 原句并通过 S1a 字节边界验证。 */
export function locateQuoteByteRange(
  chunkText: string,
  quote: string,
  minStartByte = 0,
): LocatedQuoteRange | null {
  if (!chunkText || !quote || !quote.trim()) return null;
  const chunkBytes = Buffer.from(chunkText, 'utf8');
  const quoteBytes = Buffer.from(quote, 'utf8');
  if (quoteBytes.length === 0 || minStartByte < 0 || minStartByte >= chunkBytes.length) return null;
  const start = chunkBytes.indexOf(quoteBytes, minStartByte);
  if (start < 0) return null;
  const end = start + quoteBytes.length;
  try {
    const verified = documentClaimQuoteBytes(chunkText, start, end);
    return {
      quote: verified.quote,
      quoteStartByte: start,
      quoteEndByte: end,
      quoteDigest: verified.quoteDigest,
    };
  } catch {
    return null;
  }
}

interface RawSegment {
  readonly text: string;
  readonly byteOffset: number;
}

/** 将分块拆成保留原字符的子句/行/列表项，返回每个片段在原文本中的精确 UTF-8 起始字节。 */
function splitVerbatimSegments(chunkText: string): RawSegment[] {
  const out: RawSegment[] = [];
  const lineRe = /[^\r\n]+/gu;
  let lineMatch: RegExpExecArray | null;
  while ((lineMatch = lineRe.exec(chunkText)) !== null) {
    const lineText = lineMatch[0];
    const lineStartChar = lineMatch.index;
    const sentenceRe = /[^。！？!?;；]+(?:[。！？!?;；]|(?=\.\s+[A-Z\u4e00-\u9fff])|$)/gu;
    let sentMatch: RegExpExecArray | null;
    while ((sentMatch = sentenceRe.exec(lineText)) !== null) {
      const raw = sentMatch[0];
      const leadingWs = /^\s*/u.exec(raw)?.[0].length ?? 0;
      const trimmed = raw.trim();
      if (trimmed.length < MIN_SEGMENT_CHARS) continue;
      const clamped =
        Array.from(trimmed).length > MAX_DOCUMENT_CLAIM_QUOTE_CHARS
          ? Array.from(trimmed).slice(0, MAX_DOCUMENT_CLAIM_QUOTE_CHARS).join('').trim()
          : trimmed;
      if (clamped.length < MIN_SEGMENT_CHARS) continue;
      const charIndex = lineStartChar + sentMatch.index + leadingWs;
      const byteOffset = Buffer.byteLength(chunkText.slice(0, charIndex), 'utf8');
      out.push({ text: clamped, byteOffset });
    }
  }
  return out;
}

function normalizeStatement(raw: string): string {
  const compact = raw.replace(/\s+/gu, ' ').trim();
  return compact.length > MAX_DOCUMENT_CLAIM_STATEMENT_CHARS
    ? compact.slice(0, MAX_DOCUMENT_CLAIM_STATEMENT_CHARS)
    : compact;
}

function classifySegment(segment: string): PatternRule | null {
  for (const rule of DETERMINISTIC_RULES) {
    if (rule.pattern.test(segment)) return rule;
  }
  return null;
}

function clampMaxCandidates(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) return DEFAULT_MAX_CANDIDATES;
  return Math.min(raw, HARD_MAX_CANDIDATES);
}

/** 零幻觉确定性抽取：仅产出可由服务端 UTF-8 字节边界 100% 复核的候选 Claim。 */
export function extractDeterministicDocumentClaims(
  chunkText: string,
  opts?: { maxCandidates?: number },
): ExtractedDocumentClaimCandidate[] {
  const limit = clampMaxCandidates(opts?.maxCandidates);
  const segments = splitVerbatimSegments(chunkText);
  const seen = new Set<string>();
  const out: ExtractedDocumentClaimCandidate[] = [];

  for (const seg of segments) {
    if (out.length >= limit) break;
    const matched = classifySegment(seg.text);
    if (!matched) continue;
    const located = locateQuoteByteRange(chunkText, seg.text, seg.byteOffset);
    if (!located) continue;
    const statement = normalizeStatement(located.quote);
    if (!validDocumentClaimStatement(statement)) continue;
    const dedupKey = `${matched.type}:${located.quoteDigest}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    out.push({
      type: matched.type,
      statement,
      quote: located.quote,
      quoteStartByte: located.quoteStartByte,
      quoteEndByte: located.quoteEndByte,
      quoteDigest: located.quoteDigest,
      confidence: matched.confidence,
      extractionSource: 'deterministic',
    });
  }
  return out;
}

function clampConfidence(raw?: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0.8;
  return Math.max(0.1, Math.min(1, raw));
}

/**
 * 合并可选模型建议与确定性抽取候选；
 * 所有模型建议必须通过 type/statement 契约与 `locateQuoteByteRange` 服务端原句字节复核，
 * 未锚定在原文中的建议一律丢弃并计入 `droppedModelSuggestions`。
 */
export function proposeDocumentClaimCandidates(
  chunkText: string,
  modelSuggestions: readonly ModelClaimSuggestion[] = [],
  opts?: { maxCandidates?: number },
): ProposalResult {
  const limit = clampMaxCandidates(opts?.maxCandidates);
  const seen = new Set<string>();
  const candidates: ExtractedDocumentClaimCandidate[] = [];
  let droppedModelSuggestions = 0;

  for (const suggestion of modelSuggestions) {
    if (!validDocumentClaimType(suggestion.type) || !validDocumentClaimStatement(suggestion.statement)) {
      droppedModelSuggestions += 1;
      continue;
    }
    const located = locateQuoteByteRange(chunkText, suggestion.quote);
    if (!located) {
      droppedModelSuggestions += 1;
      continue;
    }
    const statement = normalizeStatement(suggestion.statement);
    const dedupKey = `${suggestion.type}:${located.quoteDigest}:${statement.toLowerCase()}`;
    if (seen.has(dedupKey) || candidates.length >= limit) continue;
    seen.add(dedupKey);
    candidates.push({
      type: suggestion.type,
      statement,
      quote: located.quote,
      quoteStartByte: located.quoteStartByte,
      quoteEndByte: located.quoteEndByte,
      quoteDigest: located.quoteDigest,
      confidence: clampConfidence(suggestion.confidence),
      extractionSource: 'model_verified',
    });
  }

  for (const det of extractDeterministicDocumentClaims(chunkText, { maxCandidates: limit })) {
    if (candidates.length >= limit) break;
    const dedupKey = `${det.type}:${det.quoteDigest}:${det.statement.toLowerCase()}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    candidates.push(det);
  }

  return { candidates, droppedModelSuggestions };
}
