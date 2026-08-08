import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  evaluateDecisionCard,
  renderDecisionCard,
} from "./pr-decision-card.mjs";

const HEAD = "a".repeat(40);
const WORKFLOW = readFileSync(
  new URL("../.github/workflows/pr-decision-card.yml", import.meta.url),
  "utf8",
);

function body(overrides = {}) {
  const values = {
    repository: "mlhjyx/global-backend",
    prNumber: "#237",
    headSha: HEAD,
    generatedAt: "2026-07-27T12:00:00.000Z",
    businessResult: "降低非技术产品负责人判断合并风险的成本",
    userValue: "在 PR 中直接看到可理解的合并决策卡",
    unchanged: "不改变公共 API、生产服务或合并授权规则",
    paths: "生成失败时检查保持不通过，修正文后可重跑",
    sensitiveImpact: "无数据、权限、迁移、外部合同或生产影响",
    technicalGate: "PASS；单测与 CI 证据齐全",
    independentReview: "RECOMMEND_MERGE；未发现阻断问题",
    riskRollback: "最大风险是误报过期；回退为撤销工作流提交",
    productAuthorization: "AWAITING_PRODUCT_OWNER",
    codexRecommendation: "MERGE",
    ...overrides,
  };
  return `## 非技术合并决策卡

- 决策卡仓库：${values.repository}
- 决策卡 PR：${values.prNumber}
- 决策卡 head：${values.headSha}
- 决策卡生成时间：${values.generatedAt}
- 关联业务结果、Capability / Scenario / Page / Object：${values.businessResult}
- 用户会实际得到什么：${values.userValue}
- 明确没有改变什么：${values.unchanged}
- 成功、失败与恢复路径：${values.paths}
- 数据、权限、迁移、外部合同或生产影响：${values.sensitiveImpact}
- 技术门：${values.technicalGate}
- 独立审查代理：${values.independentReview}
- 最大剩余风险、未知项与回退方式：${values.riskRollback}
- 产品负责人授权：${values.productAuthorization}
- Codex 建议：${values.codexRecommendation}

## 合规
`;
}

function event(cardBody = body(), headSha = HEAD, draft = false) {
  return {
    repository: { full_name: "mlhjyx/global-backend" },
    number: 237,
    pull_request: {
      number: 237,
      head: { sha: headSha },
      draft,
      body: cardBody,
    },
  };
}

test("author-controlled positive declarations never become a trusted ready state", () => {
  const result = evaluateDecisionCard(
    event(
      body({
        technicalGate: "PASS；可选 PASS / HOLD / UNKNOWN",
        independentReview:
          "RECOMMEND_MERGE；可选 RECOMMEND_MERGE / RECOMMEND_HOLD / NEED_USER_DECISION",
        codexRecommendation: "MERGE；可选 MERGE / HOLD / NEED_USER_DECISION",
      }),
    ),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.status, "CURRENT_UNVERIFIED");
  assert.equal(result.blocking, true);
  assert.equal(result.technicalGate, "PASS");
  assert.equal(result.independentReview, "RECOMMEND_MERGE");
  assert.match(result.reasons.join(" "), /可信外部 provenance/);
  assert.match(renderDecisionCard(result), /未验证声明/);
});

test("a Draft may display an unverified merge declaration without blocking planning", () => {
  const result = evaluateDecisionCard(
    event(body(), HEAD, true),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.status, "CURRENT_UNVERIFIED");
  assert.equal(result.blocking, false);
});

test("a future timestamp cannot enter a nonblocking MERGE state", () => {
  const result = evaluateDecisionCard(
    event(body({ generatedAt: "2026-07-27T12:10:01.000Z" })),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.blocking, true);
  assert.match(result.reasons.join(" "), /生成时间无效或位于未来/);
});

test("pull_request_target execution is restricted to the default branch", () => {
  assert.match(WORKFLOW, /name:\s*nontechnical decision card integrity/);
  assert.match(
    WORKFLOW,
    /if:\s*github\.event\.pull_request\.base\.ref\s*==\s*github\.event\.repository\.default_branch/,
  );
  assert.match(
    WORKFLOW,
    /ref:\s*\${{\s*github\.event\.pull_request\.base\.sha\s*}}/,
  );
  assert.doesNotMatch(WORKFLOW, /pull_request\.head\.sha/);
});

test("decision-card workflow actions are pinned to verified full revisions", () => {
  assert.match(
    WORKFLOW,
    /uses:\s*actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1\s+# v7/,
  );
  assert.match(
    WORKFLOW,
    /uses:\s*actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020\s+# v7/,
  );
  assert.match(
    WORKFLOW,
    /uses:\s*actions\/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd\s+# v8/,
  );
  assert.doesNotMatch(WORKFLOW, /uses:\s*[^\s#]+@v\d/);
});

test("a changed head makes an old MERGE recommendation stale and blocking", () => {
  const result = evaluateDecisionCard(
    event(body(), "b".repeat(40)),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.status, "STALE");
  assert.equal(result.blocking, true);
});

test("an unfinished non-merge card stays visible without pretending readiness", () => {
  const result = evaluateDecisionCard(
    event(
      body({
        userValue: "<由 Codex 填写>",
        technicalGate: "UNKNOWN",
        independentReview: "NEED_USER_DECISION",
        codexRecommendation: "NEED_USER_DECISION",
      }),
    ),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.blocking, false);
});

test("template placeholders wrapped in Markdown code remain incomplete", () => {
  const result = evaluateDecisionCard(
    event(
      body({
        repository: "`<owner/repository>`",
        prNumber: "`#<number>`",
        headSha: "`<40-char SHA>`",
        generatedAt: "`<ISO 8601>`",
        userValue: "`<由 Codex 填写>`",
        codexRecommendation: "`NEED_USER_DECISION`",
      }),
    ),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.blocking, false);
});

test("product authorization text cannot override a technical hold", () => {
  const result = evaluateDecisionCard(
    event(
      body({
        technicalGate: "HOLD；存在失败检查",
        independentReview: "RECOMMEND_HOLD；需要修复",
        productAuthorization: "同意合并 PR #237",
        codexRecommendation: "HOLD",
      }),
    ),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.status, "HOLD");
  assert.equal(result.blocking, false);
  assert.match(renderDecisionCard(result), /机器人不把它当作自动合并输入/);
});

test("machine, reviewer, and user authorization remain separate untrusted lanes", () => {
  const result = evaluateDecisionCard(
    event(
      body({
        technicalGate: "PASS；作者声称 CI 全绿",
        independentReview: "RECOMMEND_MERGE；作者声称已独立审查",
        productAuthorization: "AUTHORIZED；作者声称产品负责人同意",
        codexRecommendation: "MERGE",
      }),
    ),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.gates.machine.trusted, false);
  assert.equal(result.gates.reviewer.trusted, false);
  assert.equal(result.gates.userAuthorization.status, "NOT_AUTHORIZED");
  assert.equal(result.gates.userAuthorization.trusted, false);
  assert.notStrictEqual(result.gates.machine, result.gates.reviewer);
  assert.notStrictEqual(result.gates.reviewer, result.gates.userAuthorization);
  assert.match(renderDecisionCard(result), /用户授权门：`NOT_AUTHORIZED`/);
});

test("negated status phrases cannot be parsed as positive enumerations", () => {
  const result = evaluateDecisionCard(
    event(
      body({
        technicalGate: "NOT PASS",
        independentReview: "DO NOT RECOMMEND_MERGE",
        codexRecommendation: "DO NOT MERGE",
      }),
    ),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  assert.equal(result.status, "INCOMPLETE");
  assert.equal(result.blocking, false);
  assert.equal(result.technicalGate, null);
  assert.equal(result.independentReview, null);
  assert.equal(result.recommendation, null);
  assert.equal(
    result.reasons.filter((reason) => reason.includes("精确枚举值")).length,
    3,
  );
});

test("untrusted HTML comments from the PR body are not copied into the bot marker", () => {
  const result = evaluateDecisionCard(
    event(body({ userValue: "可见结果 <!-- injected -->" })),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  const rendered = renderDecisionCard(result);
  assert.equal(
    rendered.match(/codex-nontechnical-decision-card:v1/g)?.length,
    1,
  );
  assert.equal(rendered.includes("injected"), false);
});

test("bot output neutralizes Markdown, mentions, and bidi controls from the PR body", () => {
  const result = evaluateDecisionCard(
    event(
      body({
        userValue:
          "查看 [伪链接](https://example.invalid) ![图片](https://example.invalid/a.png) @maintainer \u202eMERGE",
      }),
    ),
    new Date("2026-07-27T12:05:00.000Z"),
  );
  const rendered = renderDecisionCard(result);
  assert.equal(rendered.includes("[伪链接]("), false);
  assert.equal(rendered.includes("![图片]("), false);
  assert.equal(rendered.includes("@maintainer"), false);
  assert.equal(rendered.includes("\u202e"), false);
  assert.match(rendered, /＠maintainer/);
});
