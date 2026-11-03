// 文档时效判定的纯函数；由 verify-docs.mjs 消费，行为由 docs-verification-policy.json 的 freshness 块控制。

export function parseLastVerified(text) {
  const match = String(text).match(/>\s*最后核验[:：]\s*`?(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

export function ageInDays(dateString, now = new Date()) {
  const then = Date.parse(`${dateString}T00:00:00Z`);
  if (Number.isNaN(then)) return null;
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((today - then) / 86_400_000);
}

export function freshnessVerdict({ text, now = new Date(), maxAgeDays = 90 }) {
  const date = parseLastVerified(text);
  if (!date) {
    return { status: "missing", code: "DOC_VERIFICATION_MISSING", date: null, ageDays: null };
  }
  const ageDays = ageInDays(date, now);
  if (ageDays === null) {
    return { status: "invalid", code: "DOC_VERIFICATION_INVALID", date, ageDays: null };
  }
  if (ageDays > maxAgeDays) {
    return { status: "stale", code: "DOC_STALE", date, ageDays };
  }
  return { status: "ok", code: null, date, ageDays };
}
