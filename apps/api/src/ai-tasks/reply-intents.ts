/**
 * `engage.reply_classify` 的意图闭集（7 枚举）。
 *
 * 归属说明：枚举是 AI task 契约（输出 schema 的 enum）与确定性守卫（低置信升级、
 * 自动回复冲突）的共同真值。放在 `ai-tasks/` 让契约目录拥有它，skills 侧引用，
 * 避免 `task-registry` 反向依赖 skills 层（registry 被所有 worker/activity 导入）。
 */

export const REPLY_INTENTS = [
  "POSITIVE",
  "NEGATIVE",
  "NEUTRAL",
  "OUT_OF_OFFICE",
  "UNSUBSCRIBE",
  "BOUNCE",
  "NEEDS_HUMAN",
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export function isReplyIntent(value: string): value is ReplyIntent {
  return (REPLY_INTENTS as readonly string[]).includes(value);
}
