#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

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

function sanitize(value) {
  return String(value ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

function parseCardInput(body) {
  const card = Object.fromEntries(Object.keys(FIELDS).map((key) => [key, ""]));
  const errors = [];
  if (typeof body !== "string" || Buffer.byteLength(body) > 256 * 1024) {
    return { card, errors: ["决策卡正文缺失或超过字节上限"] };
  }
  const visible = body.replace(/<!--[\s\S]*?-->/g, "");
  if (visible.includes("<!--") || visible.includes("-->")) {
    errors.push("正文包含未闭合的 HTML 注释");
  }
  const labels = new Map(
    Object.entries(FIELDS).map(([key, label]) => [label, key]),
  );
  const seen = new Set();
  let sections = 0;
  let inCard = false;
  let fence;
  for (const line of visible.split(/\r?\n/)) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = marker[1];
      continue;
    }
    if (/^ {0,3}##[ \t]+非技术合并决策卡[ \t]*#*[ \t]*$/.test(line)) {
      sections += 1;
      inCard = true;
      continue;
    }
    if (/^ {0,3}#{1,2}(?:[ \t]+|$)/.test(line)) inCard = false;
    if (!inCard || !/^ {0,3}(?:[-*+]|[0-9]{1,9}[.)])[ \t]+/.test(line))
      continue;
    const field = line.match(/^ {0,3}-[ \t]+([^：:]+)[：:][ \t]*(.*)$/);
    const key = labels.get(field?.[1]?.trim());
    if (!key) {
      errors.push("决策卡包含未知或畸形字段");
      continue;
    }
    if (seen.has(key)) {
      errors.push(`决策卡字段重复：${FIELDS[key]}`);
      continue;
    }
    seen.add(key);
    let value = field[2].trim();
    if (value.startsWith("`") && value.endsWith("`"))
      value = value.slice(1, -1).trim();
    if (
      [
        "repository",
        "prNumber",
        "headSha",
        "generatedAt",
        "technicalGate",
        "independentReview",
        "codexRecommendation",
      ].includes(key) &&
      /[\u0000-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(
        value,
      )
    ) {
      errors.push(`决策卡结构字段含不可见控制字符：${FIELDS[key]}`);
    }
    if (value.length > 1200) errors.push(`决策卡字段超长：${FIELDS[key]}`);
    card[key] = sanitize(value);
  }
  if (sections !== 1) errors.push("正文必须有且只有一个可见决策卡区段");
  return { card, errors };
}

function utcTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const canonical = value.includes(".") ? value : value.replace("Z", ".000Z");
  return new Date(time).toISOString() === canonical ? time : NaN;
}

function placeholder(value) {
  return (
    !value ||
    /^(?:TBD|TODO|UNKNOWN|待填写|待补充|&lt;.*&gt;|\.\.\.)$/i.test(value)
  );
}

function leadingToken(value, allowed) {
  const normalized = value.toUpperCase();
  const match = normalized.match(
    /^(?:`([A-Z_]+)`|([A-Z_]+))(?:$|[\s；;，,。.：:（(])/,
  );
  return allowed.find((item) => item === (match?.[1] ?? match?.[2]));
}

function parsePrNumber(value) {
  const match = value.match(/^#?([1-9]\d*)$/);
  const number = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}

export function parseDecisionCard(body) {
  return parseCardInput(body).card;
}

export function evaluateDecisionCard(event, now = new Date()) {
  const repository = sanitize(event?.repository?.full_name);
  const prNumber = Number(event?.pull_request?.number ?? event?.number);
  const headSha = sanitize(event?.pull_request?.head?.sha).toLowerCase();
  const parsed = parseCardInput(event?.pull_request?.body);
  const card = parsed.card;
  const reasons = [...parsed.errors];
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
  const generatedAtMs = utcTimestamp(card.generatedAt);
  const bindingPresent = bindingMissing.length === 0;
  const generatedAtValid =
    Number.isFinite(generatedAtMs) &&
    generatedAtMs <= now.getTime() + 5 * 60 * 1000;
  const validBinding =
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) &&
    Number.isSafeInteger(prNumber) &&
    prNumber > 0 &&
    /^[0-9a-f]{40}$/.test(headSha) &&
    /^[0-9a-f]{40}$/.test(card.headSha) &&
    boundPrNumber !== null;
  if (!validBinding) reasons.push("决策卡或事件绑定格式无效");
  const stale =
    bindingPresent &&
    (card.repository !== repository ||
      boundPrNumber !== prNumber ||
      card.headSha.toLowerCase() !== headSha);
  if (stale) {
    reasons.push("决策卡绑定的仓库、PR 或 head SHA 与当前 PR 不一致");
  }
  if (bindingPresent && !generatedAtValid) {
    reasons.push("决策卡生成时间无效或位于未来");
  }

  const recommendation = leadingToken(card.codexRecommendation, [
    "NEED_USER_DECISION",
    "HOLD",
    "MERGE",
  ]);
  const technicalGate = leadingToken(card.technicalGate, [
    "UNKNOWN",
    "HOLD",
    "PASS",
  ]);
  const independentReview = leadingToken(card.independentReview, [
    "NEED_USER_DECISION",
    "RECOMMEND_HOLD",
    "RECOMMEND_MERGE",
  ]);
  const draft = event?.pull_request?.draft === true;
  if (!placeholder(card.codexRecommendation) && !recommendation) {
    reasons.push("Codex 建议必须以精确枚举值开头");
  }
  if (!placeholder(card.technicalGate) && !technicalGate) {
    reasons.push("技术门必须以精确枚举值开头");
  }
  if (!placeholder(card.independentReview) && !independentReview) {
    reasons.push("独立审查必须以精确枚举值开头");
  }

  let status = "INCOMPLETE";
  if (stale) {
    status = "STALE";
  } else if (
    bindingMissing.length === 0 &&
    missing.length === 0 &&
    generatedAtValid
  ) {
    if (
      recommendation === "HOLD" ||
      technicalGate === "HOLD" ||
      independentReview === "RECOMMEND_HOLD"
    ) {
      status = "HOLD";
    } else if (
      recommendation === "NEED_USER_DECISION" ||
      independentReview === "NEED_USER_DECISION" ||
      technicalGate === "UNKNOWN"
    ) {
      status = "NEED_USER_DECISION";
    } else if (
      recommendation === "MERGE" &&
      technicalGate === "PASS" &&
      independentReview === "RECOMMEND_MERGE"
    ) {
      status = "CURRENT_UNVERIFIED";
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
  const mergeCandidate =
    recommendation === "MERGE" &&
    technicalGate === "PASS" &&
    independentReview === "RECOMMEND_MERGE";
  const integrityValid =
    reasons.length === 0 && validBinding && generatedAtValid;
  if (!integrityValid && status !== "STALE") status = "INCOMPLETE";

  return {
    schemaVersion: "pr-decision-card-status/v4",
    status,
    blocking: !draft && !integrityValid,
    integrity: {
      status: integrityValid ? "PASS" : "FAIL",
      freshnessPolicy: "EXACT_PR_HEAD_NO_WALL_CLOCK_TTL",
    },
    draft,
    mergeCandidate,
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
    gates: {
      machine: {
        status: technicalGate ?? "UNDECLARED",
        trusted: false,
        provenance: "PR_BODY_DECLARATION",
      },
      reviewer: {
        status: independentReview ?? "UNDECLARED",
        trusted: false,
        provenance: "PR_BODY_DECLARATION",
      },
      userAuthorization: {
        status: "NOT_AUTHORIZED",
        trusted: false,
        provenance: "PR_BODY_DECLARATION",
        declared: card.productAuthorization || null,
      },
    },
    reasons: [...new Set(reasons)],
    card,
  };
}

function shown(value) {
  if (placeholder(value)) return "UNKNOWN";
  return value
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]()#!|>~])/g, "\\$1")
    .replace(/@/g, "＠");
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
> PR 正文由作者控制，因此其中的技术门、独立审查和 Codex 建议一律按**未验证声明**展示；本机器人永远不会仅凭正文输出“已准备合并”。
> \`nontechnical decision card freshness\` 只校验卡片完整性和精确 PR/head 绑定：非 Draft 的畸形、缺失、陈旧或矛盾卡片必须阻断。通过不等于实际 CI、独立审查、用户授权或运行晋级证明。卡片不要求按日重签；合并前仍须独立回读当前真实证据。

- 卡片状态：\`${result.status}\`
- 完整性检查：\`${result.integrity.status}\`（不授予合并权限）
- PR 类型：\`${result.draft ? "DRAFT" : "READY"}\`
- Merge-candidate 声明：\`${result.mergeCandidate ? "YES_UNVERIFIED" : "NO"}\`
- 实时绑定：\`${result.repository}#${result.prNumber}@${result.headSha}\`
- 自动检查时间：\`${result.generatedAt}\`
- 用户/项目得到什么：${shown(card.userValue)}
- 关联业务结果：${shown(card.businessResult)}
- 明确没有改变什么：${shown(card.unchanged)}
- 成功、失败与恢复：${shown(card.paths)}
- 数据、权限、迁移、外部合同或生产影响：${shown(card.sensitiveImpact)}
- 机器技术门：\`${result.gates.machine.status}\`（正文声明，未验证；真实门只认受信 check run）
- 独立审查门：\`${result.gates.reviewer.status}\`（正文声明，未验证；真实门只认独立 review provenance）
- 用户授权门：\`${result.gates.userAuthorization.status}\`（正文只展示：${shown(card.productAuthorization)}；机器人不把它当作自动合并输入）
- 最大风险与回退：${shown(card.riskRollback)}
- 正文自报 Codex 建议（未验证）：${shown(card.codexRecommendation)}

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
    const event = JSON.parse(await readFile(args.event, "utf8"));
    const renderedAt = utcTimestamp(result?.generatedAt ?? "");
    if (
      !Number.isFinite(renderedAt) ||
      renderedAt > Date.now() + 5 * 60 * 1000 ||
      !isDeepStrictEqual(
        result,
        evaluateDecisionCard(event, new Date(renderedAt)),
      )
    )
      throw new Error("invalid decision card result");
    // Compare the complete result, then freshly evaluate the trusted event.
    // A partial or altered result cannot supply its own verdict or trust lane.
    const current = evaluateDecisionCard(event);
    if (result.blocking || current.blocking) {
      console.error(
        `decision card declaration is ${result.blocking ? result.status : current.status}: ${(result.blocking ? result.reasons : current.reasons).join("; ")}`,
      );
      process.exitCode = 1;
    }
    return;
  }
  throw new Error(
    "usage: pr-decision-card render --event event.json --output card.md --result result.json | check --event event.json --result result.json",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch(() => {
    console.error("DECISION_CARD_COMMAND_FAILED");
    process.exitCode = 1;
  });
}
