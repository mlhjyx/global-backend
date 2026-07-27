#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const COMMENT_MARKER = "<!-- codex-nontechnical-decision-card:v1 -->";

const FIELDS = {
  repository: "决策卡仓库",
  prNumber: "决策卡 PR",
  headSha: "决策卡 head",
  generatedAt: "决策卡生成时间",
  businessResult: "关联业务结果、Capability / Scenario / Page / Object",
  userValue: "用户会实际得到什么",
  unchanged: "明确没有改变什么",
  paths: "成功、失败与恢复路径",
  sensitiveImpact: "数据、权限、迁移、外部合同或生产影响",
  technicalGate: "技术门",
  independentReview: "独立审查代理",
  riskRollback: "最大剩余风险、未知项与回退方式",
  productAuthorization: "产品负责人授权",
  codexRecommendation: "Codex 建议",
};

const REQUIRED_NARRATIVE_FIELDS = [
  "businessResult",
  "userValue",
  "unchanged",
  "paths",
  "sensitiveImpact",
  "technicalGate",
  "independentReview",
  "riskRollback",
  "productAuthorization",
  "codexRecommendation",
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitize(value) {
  return String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function rawSection(body) {
  const match = String(body ?? "").match(
    /(?:^|\n)##\s+非技术合并决策卡\s*\n([\s\S]*?)(?=\n##\s+|$)/,
  );
  return match?.[1] ?? "";
}

function fieldValue(section, label) {
  const pattern = new RegExp(
    `^\\s*-\\s*${escapeRegExp(label)}\\s*[：:]\\s*(.*)$`,
    "m",
  );
  const value = sanitize(section.match(pattern)?.[1] ?? "");
  return value.startsWith("`") && value.endsWith("`")
    ? value.slice(1, -1).trim()
    : value;
}

function placeholder(value) {
  return (
    !value ||
    /^(?:TBD|TODO|UNKNOWN|待填写|待补充|&lt;.*&gt;|\.\.\.)$/i.test(value)
  );
}

function token(value, allowed) {
  return allowed.find((item) =>
    new RegExp(`(?:^|[^A-Z_])${escapeRegExp(item)}(?:$|[^A-Z_])`).test(
      value.toUpperCase(),
    ),
  );
}

function parsePrNumber(value) {
  const match = value.match(/^#?(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function parseDecisionCard(body) {
  const section = rawSection(body);
  return Object.fromEntries(
    Object.entries(FIELDS).map(([key, label]) => [
      key,
      fieldValue(section, label),
    ]),
  );
}

export function evaluateDecisionCard(event, now = new Date()) {
  const repository = sanitize(event?.repository?.full_name);
  const prNumber = Number(event?.pull_request?.number ?? event?.number);
  const headSha = sanitize(event?.pull_request?.head?.sha).toLowerCase();
  const card = parseDecisionCard(event?.pull_request?.body);
  const reasons = [];
  const missing = REQUIRED_NARRATIVE_FIELDS.filter((key) =>
    placeholder(card[key]),
  );
  const bindingMissing = [
    "repository",
    "prNumber",
    "headSha",
    "generatedAt",
  ].filter((key) => placeholder(card[key]));

  if (bindingMissing.length > 0) {
    reasons.push(`缺少绑定字段：${bindingMissing.join(", ")}`);
  }
  if (missing.length > 0) {
    reasons.push(`缺少决策字段：${missing.join(", ")}`);
  }

  const boundPrNumber = parsePrNumber(card.prNumber);
  const generatedAtMs = Date.parse(card.generatedAt);
  const bindingPresent = bindingMissing.length === 0;
  const stale =
    bindingPresent &&
    (card.repository !== repository ||
      boundPrNumber !== prNumber ||
      card.headSha.toLowerCase() !== headSha);
  if (stale) {
    reasons.push("决策卡绑定的仓库、PR 或 head SHA 与当前 PR 不一致");
  }
  if (
    bindingPresent &&
    (!Number.isFinite(generatedAtMs) ||
      generatedAtMs > now.getTime() + 5 * 60 * 1000)
  ) {
    reasons.push("决策卡生成时间无效或位于未来");
  }

  const recommendation = token(card.codexRecommendation, [
    "NEED_USER_DECISION",
    "HOLD",
    "MERGE",
  ]);
  const technicalGate = token(card.technicalGate, ["UNKNOWN", "HOLD", "PASS"]);
  const independentReview = token(card.independentReview, [
    "NEED_USER_DECISION",
    "RECOMMEND_HOLD",
    "RECOMMEND_MERGE",
  ]);

  let status = "INCOMPLETE";
  if (stale) {
    status = "STALE";
  } else if (
    bindingMissing.length === 0 &&
    missing.length === 0 &&
    Number.isFinite(generatedAtMs)
  ) {
    if (recommendation === "HOLD" || technicalGate === "HOLD") {
      status = "HOLD";
    } else if (
      recommendation === "NEED_USER_DECISION" ||
      independentReview === "NEED_USER_DECISION"
    ) {
      status = "NEED_USER_DECISION";
    } else if (
      recommendation === "MERGE" &&
      technicalGate === "PASS" &&
      independentReview === "RECOMMEND_MERGE"
    ) {
      status = "READY_FOR_PRODUCT_DECISION";
    } else {
      status = "INCOMPLETE";
    }
  }

  if (recommendation === "MERGE" && technicalGate !== "PASS") {
    reasons.push("Codex 建议 MERGE，但技术门不是 PASS");
  }
  if (recommendation === "MERGE" && independentReview !== "RECOMMEND_MERGE") {
    reasons.push("Codex 建议 MERGE，但独立审查尚未建议合并");
  }

  return {
    schemaVersion: "pr-decision-card-status/v1",
    status,
    blocking:
      recommendation === "MERGE" && status !== "READY_FOR_PRODUCT_DECISION",
    repository,
    prNumber,
    headSha,
    generatedAt: now.toISOString(),
    bodyBinding: {
      repository: card.repository || null,
      prNumber: boundPrNumber,
      headSha: card.headSha || null,
      generatedAt: Number.isFinite(generatedAtMs)
        ? new Date(generatedAtMs).toISOString()
        : null,
    },
    recommendation: recommendation ?? null,
    technicalGate: technicalGate ?? null,
    independentReview: independentReview ?? null,
    reasons: [...new Set(reasons)],
    card,
  };
}

function shown(value) {
  return placeholder(value) ? "UNKNOWN" : value;
}

export function renderDecisionCard(result) {
  const card = result.card;
  const reasons =
    result.reasons.length === 0
      ? "- 无"
      : result.reasons.map((reason) => `- ${reason}`).join("\n");
  return `${COMMENT_MARKER}
## 非技术合并决策卡 · 自动状态

> 本评论由默认分支上的受信脚本根据当前 PR 事件与 PR 正文生成。它只检查绑定、完整性和过期状态，**不会批准或合并 PR**。

- 卡片状态：\`${result.status}\`
- 实时绑定：\`${result.repository}#${result.prNumber}@${result.headSha}\`
- 自动检查时间：\`${result.generatedAt}\`
- 用户/项目得到什么：${shown(card.userValue)}
- 关联业务结果：${shown(card.businessResult)}
- 明确没有改变什么：${shown(card.unchanged)}
- 成功、失败与恢复：${shown(card.paths)}
- 数据、权限、迁移、外部合同或生产影响：${shown(card.sensitiveImpact)}
- 技术门：${shown(card.technicalGate)}
- 独立审查：${shown(card.independentReview)}
- 最大风险与回退：${shown(card.riskRollback)}
- Codex 建议：${shown(card.codexRecommendation)}
- 产品负责人授权：${shown(card.productAuthorization)}（仅展示，机器人不把它当作自动合并输入）

### 自动检查发现

${reasons}
`;
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value == null) {
      throw new Error("invalid arguments");
    }
    args[key.slice(2)] = value;
  }
  return { command, args };
}

async function main() {
  const { command, args } = parseArgs(process.argv.slice(2));
  if (command === "render") {
    const event = JSON.parse(await readFile(args.event, "utf8"));
    const result = evaluateDecisionCard(event);
    await writeFile(args.output, renderDecisionCard(result), "utf8");
    await writeFile(
      args.result,
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    return;
  }
  if (command === "check") {
    const result = JSON.parse(await readFile(args.result, "utf8"));
    if (result.blocking) {
      console.error(
        `decision card is ${result.status}: ${result.reasons.join("; ")}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(
    "usage: pr-decision-card render --event event.json --output card.md --result result.json | check --result result.json",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
