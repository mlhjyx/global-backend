#!/usr/bin/env node
/**
 * ch08 §3.4 G9：文件体量与函数复杂度预算门（ratchet 只降不升）。
 *
 * 规则：
 *  - 单文件行数：> 800 记 warn；> 1200 对**未登记**文件阻断；已登记文件超过其基线 maxLines 阻断。
 *  - 函数圈复杂度（解析级近似）：If/For/ForIn/ForOf/While/Do/Case(非 default)/Catch/三元/&&/||/?? 各 +1。
 *    > 40 对未登记函数阻断；已登记函数超过其基线值阻断；> 20 记 warn。
 *  - 基线 `docs/governance/ci-baselines/g9-size-budget.json` 只许收紧：
 *    文件降到 800 行以下、函数降到 20 以下后，条目必须删除（否则红）。
 *
 * 用法：
 *   node scripts/check-file-budgets.mjs                # 检查（CI/本地）
 *   node scripts/check-file-budgets.mjs --write-baseline
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const GATE = 'g9-size-budget';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE_PATH = join(repoRoot, 'docs/governance/ci-baselines/g9-size-budget.json');

const FILE_WARN_LINES = 800;
const FILE_FAIL_LINES = 1200;
const FUNCTION_WARN_COMPLEXITY = 20;
const FUNCTION_FAIL_COMPLEXITY = 40;

// 注意：git pathspec 的 `**/` 至少匹配一层目录，src 根下的文件需单独列出。
const SCAN_GLOBS = [
  'apps/api/src/*.ts',
  'apps/api/src/*.tsx',
  'apps/api/src/**/*.ts',
  'apps/api/src/**/*.tsx',
  'packages/*/src/*.ts',
  'packages/*/src/**/*.ts',
];
const EXCLUDED = /(?:\.(?:spec|test)\.tsx?|\.test-fixture\.ts|\.d\.ts)$/;

function fail(message) {
  console.error(`[${GATE}] ${message}`);
  process.exit(1);
}

export function scanFiles(root = repoRoot) {
  const output = execFileSync('git', ['ls-files', '-z', '--', ...SCAN_GLOBS], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .split('\0')
    .filter((path) => path.length > 0 && !EXCLUDED.test(path))
    .sort();
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (parent && ts.isPropertyAssignment(parent)) {
    const name = parent.name;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  }
  return '<anonymous>';
}

const DECISION_KINDS = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** 每个函数的圈复杂度（嵌套函数独立计算，不并入外层）。 */
export function functionComplexities(sourceText, fileName = 'file.ts') {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, false, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const results = [];
  const visit = (node) => {
    if (isFunctionLike(node)) {
      let complexity = 1;
      const walk = (inner) => {
        if (inner !== node && isFunctionLike(inner)) return; // 嵌套函数独立统计
        if (DECISION_KINDS.has(inner.kind)) complexity += 1;
        if (ts.isCaseClause(inner)) complexity += 1;
        if (ts.isBinaryExpression(inner)) {
          const op = inner.operatorToken.kind;
          if (
            op === ts.SyntaxKind.AmpersandAmpersandToken ||
            op === ts.SyntaxKind.BarBarToken ||
            op === ts.SyntaxKind.QuestionQuestionToken
          ) {
            complexity += 1;
          }
        }
        ts.forEachChild(inner, walk);
      };
      ts.forEachChild(node, walk);
      results.push({
        name: functionName(node),
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        complexity,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return results;
}

function analyze(files, root = repoRoot) {
  const fileBudgets = {};
  const functionBudgets = {};
  for (const path of files) {
    const text = readFileSync(join(root, path), 'utf8');
    const lines = text.split('\n').length;
    if (lines > FILE_WARN_LINES) fileBudgets[path] = { lines };
    // 键用 `file#函数名`（同名按出现顺序加序号），不含行号——行号随他人编辑漂移，
    // 含行号的基线会在每次无关改动后误报「条目失效」。
    const seenNames = new Map();
    for (const fn of functionComplexities(text, path)) {
      const ordinal = (seenNames.get(fn.name) ?? 0) + 1;
      seenNames.set(fn.name, ordinal);
      if (fn.complexity > FUNCTION_WARN_COMPLEXITY) {
        const key = ordinal === 1 ? `${path}#${fn.name}` : `${path}#${fn.name}#${ordinal}`;
        functionBudgets[key] = { file: path, name: fn.name, line: fn.line, complexity: fn.complexity };
      }
    }
  }
  return { fileBudgets, functionBudgets };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { files: {}, functions: {} };
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  } catch (error) {
    fail(`baseline is not valid JSON: ${error.message}`);
  }
}

function check({ fileBudgets, functionBudgets }) {
  const baseline = loadBaseline();
  const baselineFiles = baseline.files ?? {};
  const baselineFunctions = baseline.functions ?? {};
  const problems = [];
  const warnings = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const [path, { lines }] of Object.entries(fileBudgets)) {
    const entry = baselineFiles[path];
    if (!entry) {
      if (lines > FILE_FAIL_LINES) {
        problems.push(
          `${path}: ${lines} 行 > ${FILE_FAIL_LINES} 行上限且未登记 —— 拆分文件；确需保留则评审后登记 ` +
            'docs/governance/ci-baselines/g9-size-budget.json（owner + 到期日）。',
        );
      } else {
        warnings.push(`${path}: ${lines} 行（> ${FILE_WARN_LINES} 建议拆分）`);
      }
      continue;
    }
    if (typeof entry.maxLines !== 'number' || typeof entry.owner !== 'string' || typeof entry.expiresAt !== 'string') {
      problems.push(`基线条目 ${path} 缺少 maxLines/owner/expiresAt`);
      continue;
    }
    if (entry.expiresAt < today) {
      problems.push(`基线条目 ${path} 已过期（${entry.expiresAt}，owner ${entry.owner}）`);
    }
    if (lines > entry.maxLines) {
      problems.push(
        `${path}: ${lines} 行超过基线棘轮上限 ${entry.maxLines}（只降不升）。` +
          ' 拆分后再改基线；确需增长须在 PR 说明理由并上调 maxLines（owner 评审）。',
      );
    } else if (lines <= FILE_WARN_LINES) {
      problems.push(`基线条目 ${path} 已降到 ${FILE_WARN_LINES} 行以下（当前 ${lines}）——删除该基线条目。`);
    }
  }
  for (const path of Object.keys(baselineFiles)) {
    if (!(path in fileBudgets) && fileBudgets[path] === undefined) {
      // 文件消失或降到 warn 线以下都要求清理。
      if (!existsSync(join(repoRoot, path)) || readFileSync(join(repoRoot, path), 'utf8').split('\n').length <= FILE_WARN_LINES) {
        problems.push(`基线条目 ${path} 已不适用（文件删除或已降到 ${FILE_WARN_LINES} 行以下）——删除该条目。`);
      }
    }
  }

  for (const [key, fn] of Object.entries(functionBudgets)) {
    const entry = baselineFunctions[key];
    if (!entry) {
      if (fn.complexity > FUNCTION_FAIL_COMPLEXITY) {
        problems.push(
          `${fn.file}:${fn.line} ${fn.name} 圈复杂度 ${fn.complexity} > ${FUNCTION_FAIL_COMPLEXITY} 且未登记` +
            ' —— 拆分函数；确需保留则评审后登记基线（owner + 到期日）。',
        );
      } else {
        warnings.push(`${fn.file}:${fn.line} ${fn.name} 圈复杂度 ${fn.complexity}（> ${FUNCTION_WARN_COMPLEXITY} 建议拆分）`);
      }
      continue;
    }
    if (typeof entry.complexity !== 'number' || typeof entry.owner !== 'string' || typeof entry.expiresAt !== 'string') {
      problems.push(`函数基线条目 ${key} 缺少 complexity/owner/expiresAt`);
      continue;
    }
    if (entry.expiresAt < today) {
      problems.push(`函数基线条目 ${key} 已过期（${entry.expiresAt}，owner ${entry.owner}）`);
    }
    if (fn.complexity > entry.complexity) {
      problems.push(
        `${fn.file}:${fn.line} ${fn.name} 圈复杂度 ${fn.complexity} 超过基线 ${entry.complexity}（只降不升）。`,
      );
    }
  }
  for (const key of Object.keys(baselineFunctions)) {
    const current = functionBudgets[key];
    if (!current || current.complexity <= FUNCTION_WARN_COMPLEXITY) {
      problems.push(`函数基线条目 ${key} 已不适用（函数消失或复杂度已降到 ${FUNCTION_WARN_COMPLEXITY} 以下）——删除该条目。`);
    }
  }

  for (const warning of warnings) console.warn(`[${GATE}] warn: ${warning}`);
  if (problems.length > 0) {
    console.error(`[${GATE}] FAILED`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `[${GATE}] OK — 文件体量与函数复杂度无未登记增长（warn ${warnings.length} 条；基线文件 ${Object.keys(baselineFiles).length}、函数 ${Object.keys(baselineFunctions).length}）。`,
  );
}

function writeBaseline({ fileBudgets, functionBudgets }) {
  const files = {};
  for (const [path, { lines }] of Object.entries(fileBudgets)) {
    files[path] = {
      maxLines: lines,
      owner: 'P6-CI-10',
      expiresAt: '2027-01-31',
      reason: '存量超标文件（棘轮：只许缩小）；site-builder 相关文件随 SUB-02/03 退役后删除条目',
    };
  }
  const functions = {};
  for (const [key, fn] of Object.entries(functionBudgets)) {
    functions[key] = {
      file: fn.file,
      name: fn.name,
      line: fn.line,
      complexity: fn.complexity,
      owner: 'P6-CI-10',
      expiresAt: '2027-01-31',
      reason: '存量高复杂度函数（棘轮：只许降低）',
    };
  }
  const payload = {
    $comment:
      'G9 文件体量/复杂度基线（ch08 §3.4）：>800 行文件与 >20 复杂度函数逐条登记，只降不升；条目不再适用时必须删除。',
    thresholds: {
      fileWarnLines: FILE_WARN_LINES,
      fileFailLines: FILE_FAIL_LINES,
      functionWarnComplexity: FUNCTION_WARN_COMPLEXITY,
      functionFailComplexity: FUNCTION_FAIL_COMPLEXITY,
    },
    files,
    functions,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `[${GATE}] wrote baseline: ${Object.keys(files).length} files, ${Object.keys(functions).length} functions → ${BASELINE_PATH}`,
  );
}

function main() {
  const files = scanFiles();
  const analyzed = analyze(files);
  if (process.argv.includes('--write-baseline')) {
    writeBaseline(analyzed);
    return;
  }
  check(analyzed);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { analyze, check, writeBaseline };
