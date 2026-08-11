import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GENERATED_START =
  '<!-- BEGIN GENERATED MODEL CANDIDATE BASELINE -->';
export const GENERATED_END = '<!-- END GENERATED MODEL CANDIDATE BASELINE -->';

const STATUS_NAMES = ['runnable', 'deferred', 'preview', 'legacy-only'];
const STATUSES = new Set(STATUS_NAMES);
const DOMAINS = new Set(['text', 'image', 'video', 'embedding']);
const PROTOCOLS = new Set([
  'openai-chat-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generate-content',
  'openai-images-generations',
  'openai-images-edits',
  'openai-videos',
  'openai-embeddings',
]);
const PREFLIGHTS = new Set(['none', 'capability_probe']);
const ACTIVATIONS = new Set([
  'requires_task_evaluation',
  'requires_media_gateway',
]);
const MODEL_PROFILE_IDS = new Set([
  'deterministic',
  'structured.default',
  'structured.assembly',
  'structured.workspace_materials',
  'reasoning.high',
  'copy.premium',
  'text.summary',
  'text.bulk',
  'multimodal.review',
  'image.bulk.creative',
  'image.premium.design',
  'image.precise_edit',
  'video.primary',
  'video.premium',
  'speech.production',
  'transcription',
  'moderation.media',
  'embedding.private',
]);
const CURRENT_TASK_PROFILES = new Map([
  ['site_builder.brand_profile', 'structured.workspace_materials'],
  ['site_builder.copy', 'copy.premium'],
  ['site_builder.design_spec', 'structured.default'],
  ['site_builder.assemble', 'structured.assembly'],
  ['site_builder.assembly_fix', 'structured.assembly'],
  ['site_builder.qa_summarize', 'text.summary'],
  ['site_builder.seo_review', 'text.summary'],
]);
const EVALUATION_ORDER = [
  'quality',
  'structure',
  'factuality',
  'stability',
  'p95_latency',
  'accepted_artifact_cost',
];
const REQUIRED_BASELINE_REFERENCE_PATHS = [
  'AGENTS.md',
  'docs/status/current.md',
  'docs/architecture/current.md',
  'docs/adr/registry.md',
  'docs/roadmap/release-plan.md',
  'docs/site-builder/00-decisions-and-coordination.md',
  'docs/site-builder/02-architecture.md',
  'docs/site-builder/03-agents.md',
  'docs/site-builder/08-eval-testing.md',
  'docs/site-builder/09-m1-implementation-design.md',
];
const ACTIVE_ROUTE_DOCUMENT_PATHS = [...REQUIRED_BASELINE_REFERENCE_PATHS];
const PROMOTED_CONTEXT =
  /\bpromotedRoute\b|已晋级|已上线|active route|现役路由|生产主路/i;
const LEGACY_CONTEXT =
  /\bcurrentRoute\b|current route|\brollback\b|\blegacy(?:-only)?\b|现役|回滚|可回|回退|基线|历史/i;
const ACTIVE_PROMOTED_ALIASES = new Set(['gpt-5.6-terra', 'claude-sonnet-5']);
const BRAND_PROFILE_CONTEXT =
  /\bsite_builder\.brand_profile\b|\bbrand_profile\b|\bBrandProfile\b|品牌画像/i;
const COPY_CONTEXT = /\bsite_builder\.copy\b/;

function hasApprovedActivePromotionContext(alias, text) {
  if (alias === 'gpt-5.6-terra') return BRAND_PROFILE_CONTEXT.test(text);
  if (alias === 'claude-sonnet-5') {
    return BRAND_PROFILE_CONTEXT.test(text) || COPY_CONTEXT.test(text);
  }
  return false;
}

function escapeCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', '<br>');
}

function code(value) {
  return `\`${String(value).replaceAll('`', '')}\``;
}

function unique(values) {
  return new Set(values).size === values.length;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function hasExactKeys(value, expected) {
  return (
    isRecord(value) &&
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function hasExactSet(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    unique(value) &&
    expected.every((item) => value.includes(item))
  );
}

function hasNegatedPromotionMarker(line, markerIndex) {
  const before = line.slice(Math.max(0, markerIndex - 64), markerIndex);
  const after = line.slice(markerIndex, markerIndex + 48);
  return (
    /(?:未|尚未|没有|并非|不是|不得|不能|不可|绝不|不应|不允许|才可|才允许|需经|仍须)[^。；;.!?]{0,40}$/i.test(
      before,
    ) ||
    /(?:\bnot\b|\bno\b|\bnever\b|\bwithout\b|\bcannot\b|\bmust\s+not\b)[^.;!?]{0,40}$/i.test(
      before,
    ) ||
    /^(?:promotedRoute)?\s*(?:=|:)\s*false\b/i.test(after)
  );
}

function hasUnnegatedPromotionClaim(line, alias) {
  const aliasIndexes = [];
  for (let index = line.indexOf(alias); index !== -1;) {
    aliasIndexes.push(index);
    index = line.indexOf(alias, index + alias.length);
  }
  const markerRegex = new RegExp(PROMOTED_CONTEXT.source, 'gi');
  for (const match of line.matchAll(markerRegex)) {
    const markerIndex = match.index ?? 0;
    for (const aliasIndex of aliasIndexes) {
      if (Math.abs(aliasIndex - markerIndex) > 120) continue;
      if (!hasNegatedPromotionMarker(line, markerIndex)) return true;
    }
  }
  return false;
}

function hasOutOfScopeTaskContext(alias, text) {
  const taskIds = text.match(/\bsite_builder\.[a-z0-9_.-]+\b/gi) ?? [];
  const allowedTaskIds =
    alias === 'claude-sonnet-5'
      ? new Set(['site_builder.brand_profile', 'site_builder.copy'])
      : new Set(['site_builder.brand_profile']);
  return taskIds.some((taskId) => !allowedTaskIds.has(taskId.toLowerCase()));
}

export function loadModelCandidateBaseline(root) {
  return JSON.parse(
    readFileSync(
      join(
        root,
        'apps/api/src/site-builder/agents/model-candidate-baseline.json',
      ),
      'utf8',
    ),
  );
}

export function validateModelCandidateBaseline(baseline) {
  const errors = [];
  const fail = (detail) => errors.push(detail);

  if (!isRecord(baseline)) return ['baseline root must be an object'];
  if (baseline?.schemaVersion !== 'site-builder-model-candidate-baseline/v1') {
    fail('schemaVersion must be site-builder-model-candidate-baseline/v1');
  }
  if (
    !/^site-builder-model-candidate-baseline\/[0-9]{4}-[0-9]{2}-[0-9]{2}-v[1-9][0-9]*$/.test(
      baseline?.candidateBaselineId ?? '',
    )
  ) {
    fail('candidateBaselineId must be date-versioned and independent');
  }
  if (baseline?.scope !== 'non_runtime_evaluation_candidates') {
    fail('scope must be non_runtime_evaluation_candidates');
  }
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(baseline.effectiveDate ?? '')) {
    fail('effectiveDate must be YYYY-MM-DD');
  } else if (!baseline.candidateBaselineId?.includes(baseline.effectiveDate)) {
    fail('candidateBaselineId date must match effectiveDate');
  }
  if (!hasExactKeys(baseline.statusDefinitions, STATUS_NAMES)) {
    fail('statusDefinitions must declare exactly the four baseline states');
  } else {
    for (const status of STATUS_NAMES) {
      if (!nonEmptyString(baseline.statusDefinitions[status])) {
        fail(`statusDefinitions.${status} must be a non-empty string`);
      }
    }
  }
  if (!Array.isArray(baseline?.models) || baseline.models.length === 0) {
    fail('models must be a non-empty array');
    return errors;
  }

  const aliases = [];
  const catalog = new Map();
  for (const model of baseline.models) {
    if (!isRecord(model) || !nonEmptyString(model.alias)) {
      fail('every model must be an object with a non-empty alias');
      continue;
    }
    aliases.push(model.alias);
    catalog.set(model.alias, model);
    if (!DOMAINS.has(model.domain)) {
      fail(`unknown domain ${model.domain} for ${model.alias}`);
    }
    if (!STATUSES.has(model.status)) {
      fail(`unknown status ${model.status} for ${model.alias}`);
    }
    if (
      !Array.isArray(model.expectedProtocols) ||
      model.expectedProtocols.length === 0
    ) {
      fail(`${model.alias} must declare expectedProtocols`);
    } else {
      if (!unique(model.expectedProtocols)) {
        fail(`${model.alias} expectedProtocols must be unique`);
      }
      for (const protocol of model.expectedProtocols) {
        if (!PROTOCOLS.has(protocol)) {
          fail(`${model.alias} has unknown protocol ${protocol}`);
        }
      }
    }
    if (!nonEmptyString(model.boundary)) {
      fail(`${model.alias} must declare a non-empty boundary`);
    }
  }
  if (!unique(aliases)) fail('model aliases must be unique');

  const pools = baseline.profileCandidatePools ?? [];
  if (!Array.isArray(pools) || pools.length === 0) {
    fail('profileCandidatePools must be a non-empty array');
    return errors;
  }
  if (!unique(pools.map((pool) => pool?.profile))) {
    fail('profile candidate pools must be unique');
  }
  for (const pool of pools) {
    if (!isRecord(pool) || !MODEL_PROFILE_IDS.has(pool.profile)) {
      fail(`unknown profile candidate pool ${pool?.profile}`);
      continue;
    }
    if (!ACTIVATIONS.has(pool.activation)) {
      fail(`${pool.profile} has unknown activation ${pool.activation}`);
    }
    if (!Array.isArray(pool.candidates) || pool.candidates.length === 0) {
      fail(`${pool.profile} must contain candidates`);
      continue;
    }
    if (!unique(pool.candidates.map((candidate) => candidate.alias))) {
      fail(`${pool.profile} contains duplicate candidates`);
    }
    for (const candidate of pool.candidates) {
      if (
        !isRecord(candidate) ||
        !nonEmptyString(candidate.alias) ||
        !nonEmptyString(candidate.expectedProtocol) ||
        !PREFLIGHTS.has(candidate.preflight) ||
        !nonEmptyString(candidate.gate)
      ) {
        fail(`${pool.profile} contains an incomplete candidate`);
        continue;
      }
      const model = catalog.get(candidate.alias);
      if (!model) {
        fail(`${pool.profile} references unknown alias ${candidate.alias}`);
        continue;
      }
      if (model.status === 'legacy-only') {
        fail(`${pool.profile} includes legacy-only alias ${candidate.alias}`);
      }
      if (!model.expectedProtocols.includes(candidate.expectedProtocol)) {
        fail(
          `${pool.profile} protocol ${candidate.expectedProtocol} is not registered for ${candidate.alias}`,
        );
      }
    }
  }
  const taskPools = baseline.taskEvaluationPools ?? [];
  if (!Array.isArray(taskPools)) {
    fail('taskEvaluationPools must be an array');
  } else if (!unique(taskPools.map((pool) => pool?.taskId))) {
    fail('task evaluation pools must be unique');
  } else {
    const taskMap = new Map();
    for (const pool of taskPools) {
      if (!isRecord(pool) || !nonEmptyString(pool.taskId)) {
        fail('task evaluation pool must declare taskId');
        continue;
      }
      if (!MODEL_PROFILE_IDS.has(pool.profile)) {
        fail(`${pool.taskId} references unknown profile ${pool.profile}`);
      }
      if (
        !pools.some((candidatePool) => candidatePool.profile === pool.profile)
      ) {
        fail(`${pool.taskId} references profile without a candidate pool`);
      }
      taskMap.set(pool.taskId, pool.profile);
    }
    if (
      taskMap.size !== CURRENT_TASK_PROFILES.size ||
      [...CURRENT_TASK_PROFILES].some(
        ([taskId, profile]) => taskMap.get(taskId) !== profile,
      )
    ) {
      fail(
        'taskEvaluationPools must exactly match every current task-to-profile binding',
      );
    }
  }

  if (!isRecord(baseline.evaluationPolicy)) {
    fail('evaluationPolicy must be an object');
  } else {
    if (
      !Array.isArray(baseline.evaluationPolicy.ordering) ||
      baseline.evaluationPolicy.ordering.length !== EVALUATION_ORDER.length ||
      baseline.evaluationPolicy.ordering.some(
        (item, index) => item !== EVALUATION_ORDER[index],
      )
    ) {
      fail(
        'evaluationPolicy.ordering must preserve the approved decision order',
      );
    }
    for (const field of [
      'taskWindow',
      'diagnosticWindow',
      'qualityValidLateClass',
      'contentInvalidClass',
      'absoluteStop',
      'promotionRule',
    ]) {
      if (!nonEmptyString(baseline.evaluationPolicy[field])) {
        fail(`evaluationPolicy.${field} must be a non-empty string`);
      }
    }
  }

  if (
    !Array.isArray(baseline.followUpPrs) ||
    baseline.followUpPrs.length === 0
  ) {
    fail('followUpPrs must be a non-empty array');
  } else {
    const orders = baseline.followUpPrs.map((item) => item?.order);
    if (
      !unique(orders) ||
      orders.some(
        (order, index) =>
          !Number.isInteger(order) ||
          order <= 0 ||
          (index > 0 && order <= orders[index - 1]),
      )
    ) {
      fail('followUpPrs orders must be unique positive ascending integers');
    }
    for (const item of baseline.followUpPrs) {
      if (
        !isRecord(item) ||
        !nonEmptyString(item.name) ||
        !nonEmptyString(item.output)
      ) {
        fail('each followUpPr must declare order, name, and output');
      }
    }
  }

  const documentationPolicy = baseline.documentationPolicy;
  if (!isRecord(documentationPolicy)) {
    fail('documentationPolicy must be an object');
  } else {
    if (
      documentationPolicy.canonicalDocument !==
      'docs/site-builder/model-candidate-baseline.md'
    ) {
      fail('documentationPolicy.canonicalDocument must use the canonical path');
    }
    if (
      documentationPolicy.registrySource !==
      'apps/api/src/site-builder/agents/model-policy.registry.ts'
    ) {
      fail('documentationPolicy.registrySource must use the runtime registry');
    }
    if (
      !hasExactSet(
        documentationPolicy.requiredBaselineIdReferences,
        REQUIRED_BASELINE_REFERENCE_PATHS,
      )
    ) {
      fail(
        'documentationPolicy.requiredBaselineIdReferences must exactly match the approved authority set',
      );
    }
    if (
      !hasExactSet(
        documentationPolicy.activeRouteDocuments,
        ACTIVE_ROUTE_DOCUMENT_PATHS,
      )
    ) {
      fail(
        'documentationPolicy.activeRouteDocuments must exactly match the approved route-document set',
      );
    }
  }
  return errors;
}

export function renderModelCandidateBaselineDocument(baseline) {
  const catalog = new Map(baseline.models.map((model) => [model.alias, model]));
  const lines = [
    '# Site Builder 模型候选重基线',
    '',
    '> 文档 ID：`SITE-MODEL-CANDIDATES-001`',
    '> 生命周期：`CURRENT`',
    '> 当前事实来源：`apps/api/src/site-builder/agents/model-candidate-baseline.json`。',
    `> 机器基线：${code(baseline.candidateBaselineId)}；本文件由机器基线生成并由 ${code('pnpm docs:verify')} 校验。`,
    '',
    GENERATED_START,
    '',
    '## 边界',
    '',
    `本基线 ${code(baseline.candidateBaselineId)} 只登记非运行时候选与后续评测顺序。它本身不路由候选、晋级模型、改变 rollback、环境变量、Temporal、P4、DesignEvaluation、ReleaseManifest、MediaGateway 或公共 API，也不证明模型质量、生产可用性或部署状态。`,
    '',
    '型号可见、渠道启用或一次最小连通，只能支持进入后续 capability probe；不能跳过逐任务评测、失败门、成本结算、rollback 和用户批准。当前 BrandProfile 的 Terra→Sonnet promotion 及其 DeepSeek→GLM rollback 保持不变；未晋级任务的 active policy 与此候选基线分离，其中 design_spec 已使用确定性安全蓝图，其他任务仍须独立评测后才能路由候选。',
    '',
    '## 状态词表',
    '',
    '| 状态 | 含义 |',
    '|---|---|',
    ...Object.entries(baseline.statusDefinitions).map(
      ([status, description]) =>
        `| ${code(status)} | ${escapeCell(description)} |`,
    ),
    '',
    '## 型号目录',
    '',
    '| 精确 alias | 分域 | 状态 | 预期协议 | 边界 |',
    '|---|---|---|---|---|',
    ...baseline.models.map(
      (model) =>
        `| ${code(model.alias)} | ${code(model.domain)} | ${code(model.status)} | ${model.expectedProtocols.map(code).join('<br>')} | ${escapeCell(model.boundary)} |`,
    ),
    '',
    '## Profile 候选池',
    '',
    '候选是相互独立的评测对象，不是 primary/fallback 运行链。排序只是首轮评测顺序。',
    '',
    '| ModelProfile | activation | 候选（状态 · 预期协议 · preflight） | 进入下一门的前提 |',
    '|---|---|---|---|',
    ...baseline.profileCandidatePools.map((pool) => {
      const candidates = pool.candidates.map((candidate) => {
        const model = catalog.get(candidate.alias);
        return `${code(candidate.alias)} (${code(model.status)} · ${code(candidate.expectedProtocol)} · ${code(candidate.preflight)})`;
      });
      return `| ${code(pool.profile)} | ${code(pool.activation)} | ${candidates.join('<br>')} | ${pool.candidates.map((candidate) => escapeCell(candidate.gate)).join('<br>')} |`;
    }),
    '',
    '## Task 与 Profile 评测映射',
    '',
    '同一 Profile 的候选池可以复用 harness，但 promotion 仍逐 task 独立。',
    '',
    '| taskId | ModelProfile |',
    '|---|---|',
    ...baseline.taskEvaluationPools.map(
      (pool) => `| ${code(pool.taskId)} | ${code(pool.profile)} |`,
    ),
    '',
    '## 评测判定顺序',
    '',
    `先按 ${baseline.evaluationPolicy.ordering.map(code).join(' → ')} 判定。真实评测使用每个 task 的生产 envelope，并在超出运行时限后进入扩展诊断观察窗；${code(baseline.evaluationPolicy.qualityValidLateClass)} 与 ${code(baseline.evaluationPolicy.contentInvalidClass)} 必须分开记录。绝对止损为 ${code(baseline.evaluationPolicy.absoluteStop)}，未知结算不写成零。`,
    '',
    '## 后续 PR 顺序',
    '',
    '| 顺序 | PR | 只允许产出 |',
    '|---|---|---|',
    ...baseline.followUpPrs.map(
      (item) =>
        `| ${item.order} | ${code(item.name)} | ${escapeCell(item.output)} |`,
    ),
    '',
    '每个 PR 独立审查、跑相关测试与完整 CI 等比例门、创建 ready PR 后等待用户合并授权。候选基线、真实证据与运行时 promotion 不得合并成 mega switch。',
    '',
    GENERATED_END,
    '',
  ];
  return lines.join('\n');
}

export function checkBaselineReferences(baseline, contentsByPath) {
  const issues = [];
  for (const path of baseline.documentationPolicy
    .requiredBaselineIdReferences) {
    const content = contentsByPath.get(path);
    if (content === undefined) {
      issues.push({
        code: 'MODEL_BASELINE_REFERENCE_FILE_MISSING',
        path,
        detail: 'required baseline reference document is missing',
      });
    } else if (!content.includes(baseline.candidateBaselineId)) {
      issues.push({
        code: 'MODEL_BASELINE_ID_MISSING',
        path,
        detail: `missing ${baseline.candidateBaselineId}`,
      });
    }
  }
  return issues;
}

export function checkModelNarrativeDrift(baseline, contentsByPath) {
  const issues = [];
  const reported = new Set();
  const nonPromotedAliases = baseline.models
    .filter(
      (model) =>
        model.status !== 'legacy-only' &&
        !ACTIVE_PROMOTED_ALIASES.has(model.alias),
    )
    .map((model) => model.alias);
  const legacyAliases = baseline.models
    .filter((model) => model.status === 'legacy-only')
    .map((model) => model.alias);

  for (const path of baseline.documentationPolicy.activeRouteDocuments) {
    const content = contentsByPath.get(path);
    if (content === undefined) continue;
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      const nextLine = lines[index + 1] ?? '';
      const canJoinAdjacentLines = !(
        line.trimStart().startsWith('|') && nextLine.trimStart().startsWith('|')
      );
      const adjacentWindow = canJoinAdjacentLines
        ? `${line} ${nextLine}`
        : line;
      for (const alias of nonPromotedAliases) {
        if (
          (line.includes(alias) ||
            (canJoinAdjacentLines &&
              PROMOTED_CONTEXT.test(line) &&
              nextLine.includes(alias))) &&
          hasUnnegatedPromotionClaim(adjacentWindow, alias)
        ) {
          const issueKey = `candidate:${path}:${alias}:${index}`;
          if (reported.has(issueKey)) continue;
          reported.add(issueKey);
          issues.push({
            code: 'MODEL_CANDIDATE_PROMOTED_DRIFT',
            path,
            detail: `line ${index + 1}: ${alias} is not an active promoted route`,
          });
        }
      }
      for (const alias of ACTIVE_PROMOTED_ALIASES) {
        if (
          (line.includes(alias) ||
            (canJoinAdjacentLines &&
              PROMOTED_CONTEXT.test(line) &&
              nextLine.includes(alias))) &&
          hasUnnegatedPromotionClaim(adjacentWindow, alias) &&
          (!hasApprovedActivePromotionContext(alias, adjacentWindow) ||
            hasOutOfScopeTaskContext(alias, adjacentWindow))
        ) {
          const issueKey = `active-task:${path}:${alias}:${index}`;
          if (reported.has(issueKey)) continue;
          reported.add(issueKey);
          issues.push({
            code: 'MODEL_ACTIVE_PROMOTION_TASK_DRIFT',
            path,
            detail: `line ${index + 1}: ${alias} promotion is outside its reviewed task scope`,
          });
        }
      }
      for (const alias of legacyAliases) {
        if (
          (line.includes(alias) ||
            (canJoinAdjacentLines &&
              PROMOTED_CONTEXT.test(line) &&
              nextLine.includes(alias))) &&
          hasUnnegatedPromotionClaim(adjacentWindow, alias)
        ) {
          const issueKey = `legacy-promoted:${path}:${alias}:${index}`;
          if (reported.has(issueKey)) continue;
          reported.add(issueKey);
          issues.push({
            code: 'MODEL_LEGACY_PROMOTED_DRIFT',
            path,
            detail: `line ${index + 1}: ${alias} is legacy-only and cannot be promoted`,
          });
        } else if (line.includes(alias) && !LEGACY_CONTEXT.test(line)) {
          issues.push({
            code: 'MODEL_LEGACY_CONTEXT_DRIFT',
            path,
            detail: `line ${index + 1}: ${alias} requires currentRoute, rollback, baseline, or legacy-only context`,
          });
        }
      }
    }
  }
  return issues;
}

export function checkRegistryBaselineDerivation(baseline, registrySource) {
  const issues = [];
  if (!registrySource.includes('modelCandidateRoutesFromBaseline')) {
    issues.push({
      code: 'MODEL_REGISTRY_NOT_BASELINE_DERIVED',
      path: baseline.documentationPolicy.registrySource,
      detail:
        'registry candidates must be constructed from the machine baseline',
    });
  }
  if (/\btarget\s*\(/.test(registrySource)) {
    issues.push({
      code: 'MODEL_REGISTRY_LITERAL_TARGET',
      path: baseline.documentationPolicy.registrySource,
      detail:
        'literal target helper found; candidate aliases must come from baseline',
    });
  }
  if (/^\s+candidates:\s*[\[{]/gm.test(registrySource)) {
    issues.push({
      code: 'MODEL_REGISTRY_CANDIDATE_LITERAL',
      path: baseline.documentationPolicy.registrySource,
      detail: 'registry candidate arrays or objects must derive from baseline',
    });
  }
  const assignments = [
    ...registrySource.matchAll(
      /^\s+candidates:\s*([^;{}]*?),\s*\n\s+deterministicFallback:/gm,
    ),
  ].map((match) => match[1].trim());
  const derivedProfiles = new Set();
  for (const assignment of assignments) {
    const match = assignment.match(
      /^modelCandidateRoutesFromBaseline\(\s*'([^']+)'\s*,?\s*\)$/,
    );
    if (!match) {
      issues.push({
        code: 'MODEL_REGISTRY_CANDIDATE_LITERAL',
        path: baseline.documentationPolicy.registrySource,
        detail: `registry candidate assignment must derive from baseline: ${assignment}`,
      });
      continue;
    }
    derivedProfiles.add(match[1]);
  }
  for (const pool of baseline.profileCandidatePools) {
    if (!derivedProfiles.has(pool.profile)) {
      issues.push({
        code: 'MODEL_REGISTRY_PROFILE_POOL_MISSING',
        path: baseline.documentationPolicy.registrySource,
        detail: `registry does not derive candidate pool ${pool.profile}`,
      });
    }
  }
  return issues;
}

export function verifyModelCandidateBaseline(root) {
  const baselinePath =
    'apps/api/src/site-builder/agents/model-candidate-baseline.json';
  const issues = [];
  let baseline;
  try {
    baseline = loadModelCandidateBaseline(root);
  } catch (error) {
    return [
      {
        code: 'MODEL_BASELINE_LOAD',
        path: baselinePath,
        detail: error.message,
      },
    ];
  }
  for (const detail of validateModelCandidateBaseline(baseline)) {
    issues.push({ code: 'MODEL_BASELINE_SCHEMA', path: baselinePath, detail });
  }
  if (issues.length > 0) return issues;

  const requiredPaths = new Set([
    ...baseline.documentationPolicy.requiredBaselineIdReferences,
    ...baseline.documentationPolicy.activeRouteDocuments,
    baseline.documentationPolicy.canonicalDocument,
    baseline.documentationPolicy.registrySource,
  ]);
  const contentsByPath = new Map();
  for (const path of requiredPaths) {
    const absolutePath = join(root, path);
    if (existsSync(absolutePath)) {
      contentsByPath.set(path, readFileSync(absolutePath, 'utf8'));
    }
  }

  const canonical = contentsByPath.get(
    baseline.documentationPolicy.canonicalDocument,
  );
  if (canonical === undefined) {
    issues.push({
      code: 'MODEL_BASELINE_DOC_MISSING',
      path: baseline.documentationPolicy.canonicalDocument,
      detail: 'generated human-readable baseline document is missing',
    });
  } else if (canonical !== renderModelCandidateBaselineDocument(baseline)) {
    issues.push({
      code: 'MODEL_BASELINE_DOC_DRIFT',
      path: baseline.documentationPolicy.canonicalDocument,
      detail:
        'generated document differs from machine baseline; run pnpm docs:model-candidates',
    });
  }

  issues.push(...checkBaselineReferences(baseline, contentsByPath));
  issues.push(...checkModelNarrativeDrift(baseline, contentsByPath));
  issues.push(
    ...checkRegistryBaselineDerivation(
      baseline,
      contentsByPath.get(baseline.documentationPolicy.registrySource) ?? '',
    ),
  );
  return issues;
}
