/**
 * Bounded structured-output repair prompt builder.
 *
 * Ensures the single closed repair attempt always includes the model's
 * previous invalid JSON output (safely serialized and truncated) so the model
 * can fix only the rejected fields instead of blindly regenerating from scratch.
 */

const MAX_PREVIOUS_OUTPUT_CHARS = 12_000;
const CLOSE_TAG_RE = /<(\/?)previous_invalid_output\b/giu;

export function serializePreviousOutputForRepair(data: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    raw = String(data);
  }
  const truncated =
    raw.length > MAX_PREVIOUS_OUTPUT_CHARS
      ? `${raw.slice(0, MAX_PREVIOUS_OUTPUT_CHARS)}\n...[truncated ${raw.length - MAX_PREVIOUS_OUTPUT_CHARS} chars]`
      : raw;
  return truncated.replace(CLOSE_TAG_RE, '&lt;$1previous_invalid_output');
}

export function buildStructuredRepairPrompt(
  originalPrompt: string,
  previousData: unknown,
  repairKind: string,
  repairReason: string,
): string {
  const prev = serializePreviousOutputForRepair(previousData);
  return `${originalPrompt}\n\n上一次输出未通过${repairKind}校验。\n上一次输出内容（仅作待修正草稿）：\n<previous_invalid_output>\n${prev}\n</previous_invalid_output>\n错误：\n${repairReason}\n请只修正被拒字段，不得新增、猜测或放宽任何事实；重新只输出同时通过 JSON Schema 和任务硬门的合法 JSON。`;
}
