import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import "./governance-ci-topology.spec.mjs";
import "./governance-document-drift.spec.mjs";
import "./environment-parity-policy.spec.mjs";
import "./governance-main-worktree-sync.spec.mjs";
import "./governance-codeql-action-pin.spec.mjs";
import "./governance-oasdiff-action-pin.spec.mjs";
import "./copy-fixed-source-impact.spec.mjs";
import "./supply-chain-gates.spec.mjs";
import "./runtime-deployment-contract.spec.mjs";
import "./ghcr-runtime-publication.spec.mjs";
import "./docker-image-config-path.spec.mjs";

import {
  renderProviderRegistry,
  renderReleaseBundle,
  parseSeedProviders,
  validateDecisionGateSeparation,
  validateMergeEvidence,
  validateProviderRegistry,
  validateReleaseBundle,
  validateRequiredContexts,
  validateRuntimeEvidence,
  validateTraceability,
} from "./governance-contracts.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
const SHA_D = "d".repeat(40);
const DIGEST = `sha256:${"e".repeat(64)}`;
const NOW = new Date("2026-08-07T12:00:00.000Z");

test("the stable roadmap and ADR registry reject live-status and superseded product drift", () => {
  const releasePlan = readFileSync(
    new URL("../docs/roadmap/release-plan.md", import.meta.url),
    "utf8",
  );
  const decisions = readFileSync(
    new URL("../docs/adr/registry.md", import.meta.url),
    "utf8",
  );

  const parseMarkdownRow = (line) => {
    if (!/^\|.*\|$/.test(line)) return null;
    return line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim());
  };
  const assertStableRoadmap = (document) => {
    const lines = document.split("\n");
    assert.match(
      document,
      /Live gate verdicts and time-bound execution facts are maintained only in \[current status\]\(\.\.\/status\/current\.md\)\./,
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith("## ")),
      ["## Stable product sequence", "## Historical supersession index"],
    );
    assert.deepEqual(
      lines.filter((line) => line.startsWith("### ")),
      [
        "### Program boundaries",
        "### Stable G0-G7 definitions",
        "### Ordered delivery",
        "### Concurrency and authorization boundaries",
      ],
    );
    const historyStart = document.indexOf("## Historical supersession index");
    assert.ok(historyStart > 0);
    const activeSection = document.slice(0, historyStart);
    assert.doesNotMatch(
      document,
      /\b(?:origin\/main|main)@[0-9a-f]{7,40}\b|\bPR\s*#\d+\b|\bREADY_FOR_[A-Z_]+\b|\bNOT_AUTHORIZED\b|\bcurrentRoute\b|\bcurrent-source\b|下一门/i,
    );
    assert.doesNotMatch(
      document,
      /\b(?:current|live)\s+(?:G[0-7]\s+)?(?:gate\s+)?(?:verdict|status)\b[\s\S]{0,80}\b(?:PASS|AMBER|RED|GREEN|DONE|BLOCKED|READY|NOT_AUTHORIZED|AUTHORIZED|COMPLETED?|FAILED?)\b/i,
    );
    assert.doesNotMatch(
      activeSection,
      /\bG[0-7]\b[^\n.]{0,40}(?:=|:|\bis\b)[^\n.]{0,20}\b(?:PASS|AMBER|RED|GREEN|DONE|BLOCKED|READY|NOT_AUTHORIZED|AUTHORIZED|FAILED?|COMPLETE(?:D)?|RELEASE_CANDIDATE)\b/i,
    );
    assert.doesNotMatch(
      activeSection,
      /\bPhase\s+\d+(?:-[A-Z])?\b[^\n.]{0,100}(?:\bis\b|=|:)[^\n.]{0,20}\b(?:PASS|AMBER|RED|GREEN|DONE|BLOCKED|READY|FAILED?|COMPLETE(?:D)?)\b/i,
    );
    assert.doesNotMatch(
      activeSection,
      /\b(?:SOURCE_INTEGRATED_ALPHA|CROSS_REPO_PRODUCT_ASSEMBLY|USER_JOURNEY_[A-Z0-9_]+|COMMERCIAL_LOOP_[A-Z0-9_]+|PRODUCTION_READINESS_[A-Z0-9_]+|RELEASE_[A-Z0-9_]+|RUNTIME_[A-Z0-9_]+|PILOT_[A-Z0-9_]+|GA_[A-Z0-9_]+)\b/,
    );

    const markdownRows = lines.map(parseMarkdownRow).filter(Boolean);
    assert.equal(markdownRows.length, 10);
    const tableHeaders = markdownRows.filter(
      (cells) => cells?.[0]?.toLowerCase() === "gate",
    );
    assert.deepEqual(tableHeaders, [["Gate", "Stable proof"]]);
    const gateRows = markdownRows.filter((cells) =>
      /^G[0-7] —/.test(cells?.[0] ?? ""),
    );
    assert.equal(gateRows.length, 8);
    assert.deepEqual(
      gateRows.map(([gate]) => gate.slice(0, 2)),
      ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7"],
    );
    for (const cells of gateRows) {
      assert.equal(cells.length, 2);
      const proofWithoutTddTerms = cells[1].replace(
        "RED/GREEN evidence",
        "TDD evidence",
      );
      assert.doesNotMatch(
        proofWithoutTddTerms,
        /\b(?:PASS|AMBER|RED|GREEN|DONE|BLOCKED|READY|NOT_AUTHORIZED|AUTHORIZED|COMPLETED?|FAILED?)\b/i,
      );
    }

    const spine = /The stable product spine is `([^`]+)`/.exec(document)?.[1];
    assert.deepEqual(spine?.split(" → "), [
      "Onboarding",
      "ICP",
      "LeadQualifiedPackage",
      "Opportunity",
      "Human QGO",
      "Feedback",
    ]);
    const orderedStart = document.indexOf("### Ordered delivery");
    const boundaryStart = document.indexOf(
      "### Concurrency and authorization boundaries",
    );
    assert.ok(orderedStart >= 0 && boundaryStart > orderedStart);
    const orderedSteps = document
      .slice(orderedStart, boundaryStart)
      .split("\n")
      .filter((line) => /^\d+\. \*\*/.test(line));
    assert.equal(orderedSteps.length, 7);
    for (const [index, label] of [
      "Phase 0",
      "MVP-0",
      "MVP-1",
      "Pilot 3-A",
      "Site 3-B",
      "MVP-2",
      "Later",
    ].entries()) {
      assert.match(
        orderedSteps[index],
        new RegExp(`^${index + 1}\\. \\*\\*${label}`),
      );
    }
    assert.match(orderedSteps[2], /Opportunity[^\n]*Human QGO/);
    for (const preMvp2Step of orderedSteps.slice(0, 5)) {
      assert.doesNotMatch(preMvp2Step, /\bCampaign\b|\bemail\b|邮件/i);
    }
    assert.match(orderedSteps[5], /Campaign[^\n]*email/);

    assert.ok(historyStart > boundaryStart);
    const historicalSection = document.slice(historyStart);
    const historicalEntries = historicalSection
      .split("\n")
      .slice(1)
      .filter((line) => line.length > 0);
    assert.equal(historicalEntries.length, 2);
    for (const entry of historicalEntries) {
      assert.match(entry, /^- /);
    }
    assert.match(historicalSection, /HISTORICAL \/ SUPERSEDED/);
    assert.match(historicalSection, /MVP-1[^\n]*Opportunity[^\n]*human QGO/);
    assert.match(historicalSection, /MVP-2[^\n]*email/);
    const campaignFirstLines = lines.filter((line) =>
      /Campaign[^\n]*email[^\n]*QGO/i.test(line),
    );
    assert.ok(campaignFirstLines.length >= 1);
    for (const line of campaignFirstLines) {
      assert.match(line, /HISTORICAL \/ SUPERSEDED/);
    }
    const unmarkedCampaignContent = lines
      .filter((line) => !line.includes("HISTORICAL / SUPERSEDED"))
      .join("\n");
    assert.doesNotMatch(
      unmarkedCampaignContent,
      /Campaign[\s\S]{0,160}(?:email|邮件)[\s\S]{0,160}QGO/i,
    );
  };

  assertStableRoadmap(releasePlan);
  for (const mutation of [
    `${releasePlan}\n| Gate                     | Current verdict |\n| ------------------------ | --------------- |\n| G0 — Truth & Ownership   | \`PASS\`          |\n`,
    releasePlan.replace(
      "Binding plans, current authority",
      "`PASS / DONE` — Binding plans, current authority",
    ),
    releasePlan.replace(
      "4. **Pilot 3-A:**",
      "4. **Campaign/email:** Campaign → email → QGO.\n4. **Pilot 3-A:**",
    ),
    `${releasePlan}\nCampaign → email → QGO.\n`,
    `${releasePlan}\n### Active fast follow\nCampaign\n→ email\n→ QGO\n`,
    `${releasePlan}\nG4 current verdict is PASS.\n`,
    releasePlan.replace(
      "Disposable-database/RLS proof",
      "`Pass / Done` — Disposable-database/RLS proof",
    ),
    `${releasePlan}\n| Capability | Current status |\n| ---------- | -------------- |\n| Runtime    | BLOCKED        |\n`,
    releasePlan.replace(
      "## Historical supersession index",
      "G4 = PASS / RELEASE_CANDIDATE.\n\n## Historical supersession index",
    ),
    releasePlan.replace(
      "## Historical supersession index",
      "Phase 0 is complete; G0=`PASS / OWNERSHIP_CLOSED`.\n\n## Historical supersession index",
    ),
    releasePlan.replace(
      "## Historical supersession index",
      "Product stage: `SOURCE_INTEGRATED_ALPHA / PRODUCTION_READINESS_BLOCKED`.\n\n## Historical supersession index",
    ),
  ]) {
    assert.throws(() => assertStableRoadmap(mutation));
  }

  for (const document of [releasePlan, decisions]) {
    assert.doesNotMatch(document, /QualifiedLeadHandoff/);
    assert.match(document, /LeadQualifiedPackage/);
  }
  assert.doesNotMatch(decisions, /以下均 ACCEPTED/);
  assert.match(decisions, /\| PDR-003 \|[^\n]+\| SUPERSEDED BY PDR-004\s+\|/);
  assert.match(
    decisions,
    /\| PDR-004 \|[^\n]*LeadQualifiedPackage[^\n]*Opportunity[^\n]*Human QGO[^\n]*MVP-2[^\n]*email[^\n]*\| ACCEPTED\s+\|/,
  );
  assert.match(
    decisions,
    /`LeadQualified` only names the integration event; it is not a second canonical product object\./,
  );
  for (const preservedQualifier of ["| PDR-001 |", "| PDR-002 |"]) {
    const row = decisions
      .split("\n")
      .find((line) => line.startsWith(preservedQualifier));
    assert.match(row ?? "", /ACCEPTED ⚠待 A\/B 会签/);
  }
});

test("dynamic currentness documents separate source, runtime, program, and release truth", () => {
  const status = readFileSync(
    new URL("../docs/status/current.md", import.meta.url),
    "utf8",
  );
  const architecture = readFileSync(
    new URL("../docs/architecture/current.md", import.meta.url),
    "utf8",
  );
  const evidenceIndex = readFileSync(
    new URL("../docs/evidence/README.md", import.meta.url),
    "utf8",
  );
  const changelog = readFileSync(
    new URL("../docs/roadmap/changelog.md", import.meta.url),
    "utf8",
  );

  const assertCurrentStatus = (document) => {
    const uniqueTableRow = (prefix) => {
      const rows = document
        .split("\n")
        .filter((line) => line.startsWith(`| ${prefix}`));
      assert.equal(rows.length, 1, `${prefix} must have one canonical row`);
      return rows[0];
    };
    const growthOsCurrentRows = document.split("\n").filter((line) => {
      if (!line.startsWith("|")) return false;
      const subject = line.split("|")[1]?.trim() ?? "";
      return /^GrowthOS (?:current )?(?:authority|source)$/iu.test(subject);
    });
    assert.equal(
      growthOsCurrentRows.length,
      1,
      "GrowthOS must have one canonical current authority/source row",
    );
    assert.match(
      growthOsCurrentRows[0],
      /\| GrowthOS source\s*\|[^\n]*`79e53f391477063404a313d8f8d3f501bcbf40fc`[^\n]*`C0\/H5\/M3`[^\n]*`17e68953ff2e26ac8433db5aa49689e5f9283659`[^\n]*unreviewed/u,
    );
    const g5SiteRow = uniqueTableRow("G5-Site — Runtime Observed");
    assert.match(
      g5SiteRow,
      /`RED \/ HISTORICAL_ONLY`[^\n]*0 current[^\n]*6 historical[^\n]*`2026-09-05T03:49:25\.000Z`/u,
    );
    const g5AcquisitionRow = uniqueTableRow(
      "G5-Acquisition — Runtime Observed",
    );
    assert.match(
      g5AcquisitionRow,
      /`RED \/ NOT_READY`[^\n]*PLATFORM_BUDGET_AUTHORITY_PLATFORM_ACQUISITION_MISSING[^\n]*evidence count=0/u,
    );
    assert.match(document, /> 最后核验：2026-09-05T18:/u);
    assert.match(
      document,
      /`HEAD=origin\/main=0679a0bc510a980f65ebd33eb88b3215a97c20ba`/u,
    );
    assert.match(
      document,
      /source identity[\s\S]{0,160}`0679a0bc510a980f65ebd33eb88b3215a97c20ba`/u,
    );
    assert.match(
      document,
      /runtime identity[\s\S]{0,220}`674ff12d4d768ce5599fc07b565fe21da37dc5fe`[\s\S]{0,160}4 commits behind/u,
    );
    assert.match(
      document,
      /GrowthOS[\s\S]{0,320}`79e53f391477063404a313d8f8d3f501bcbf40fc`[\s\S]{0,160}`C0\/H5\/M3`[\s\S]{0,220}`17e68953ff2e26ac8433db5aa49689e5f9283659`[\s\S]{0,120}unreviewed/u,
    );
    assert.match(
      document,
      /Program B[\s\S]{0,320}`f3e5bc1946805f5ac84e98339efaf16008cb25aa`[\s\S]{0,160}`C6\/H5`[\s\S]{0,220}`7b983959bd93376a7f14fe90a87433d76974d035`[\s\S]{0,180}same committed tree[\s\S]{0,160}2 modified[\s\S]{0,80}2 untracked/u,
    );
    assert.match(
      document,
      /Program B[\s\S]{0,380}`C6\/H5`[\s\S]{0,500}[Aa]ccepted main slices #427\/#431\/#432[\s\S]{0,180}Task0L/u,
    );
    assert.doesNotMatch(document, /ZERO_PRODUCT_CODE/u);
    assert.match(
      document,
      /A\/B ownership seam[\s\S]{0,160}(?:closed|CLOSED)[\s\S]{0,220}platform R2[\s\S]{0,220}Program C/u,
    );
    assert.match(
      document,
      /Program C[\s\S]{0,500}durable server consumer[\s\S]{0,160}handoff receipt[\s\S]{0,160}QualificationSnapshot[\s\S]{0,160}Opportunity aggregate[\s\S]{0,160}commit-before-ACK[\s\S]{0,160}ACK_PENDING[\s\S]{0,220}QGO\/SAO\/Outcome/u,
    );
    assert.match(
      document,
      /browser ACK[\s\S]{0,180}Conversation shell[\s\S]{0,160}(?:cannot|不能)[\s\S]{0,120}Opportunity/u,
    );
    assert.match(
      document,
      /33855198691[\s\S]{0,180}`FAIL`[\s\S]{0,180}18 advisories[\s\S]{0,120}baseline 10[\s\S]{0,180}`qs` 2[\s\S]{0,120}`fast-uri` 4[\s\S]{0,120}`browserslist` 2/u,
    );
    assert.match(
      document,
      /PR #448[\s\S]{0,220}`2e1f12b445b83ca36ea198d2f0252d0aa7c1fd49`[\s\S]{0,160}`DRAFT \/ CHECKS_COMPLETE \/ SOURCE_CANDIDATE`[\s\S]{0,180}10 success \/ 1 expected skip[\s\S]{0,180}(?:not|未)[\s\S]{0,100}(?:merge|合并)/u,
    );
    assert.match(
      document,
      /`0\.0\.0\.0:3001`[\s\S]{0,100}`\[::\]:3001`[\s\S]{0,160}`\*:8080`/u,
    );
    assert.match(
      document,
      /G0 — Truth & Ownership[^\n]*`AMBER \/ PARTIAL \/ HOLD`/u,
    );
    assert.match(
      document,
      /G0 — Truth & Ownership[^\n]*Program B root\/launcher authority\/materialization gate[^\n]*(?:open|未闭合)/u,
    );
    assert.match(
      document,
      /G2 — Source\/TDD\/Security[^\n]*`AMBER \/ PARTIAL \/ CURRENT_MAIN_RED \/ SECURITY_SOURCE_CANDIDATE`[^\n]*33855198691[^\n]*PR #448[^\n]*10 success \/ 1 expected skip/u,
    );
    assert.match(
      document,
      /G5-Site — Runtime Observed[^\n]*`RED \/ HISTORICAL_ONLY`/u,
    );
    assert.match(
      document,
      /G5-Acquisition — Runtime Observed[^\n]*`RED \/ NOT_READY`/u,
    );
    assert.match(
      document,
      /G3 — Integration\/Data[^\n]*`RED \/ NOT_INTEGRATED`[^\n]*accepted A\/B source seam[^\n]*no current-data runtime E2E[^\n]*Program C/u,
    );
    assert.doesNotMatch(
      document,
      /(?:No|无) accepted A\/B (?:end-to-end )?(?:source )?seam/u,
    );
    assert.match(
      document,
      /PLATFORM_BUDGET_AUTHORITY_PLATFORM_ACQUISITION_MISSING/u,
    );
    assert.match(
      document,
      /RuntimeEvidence[\s\S]{0,180}6 total[\s\S]{0,120}0 current[\s\S]{0,120}6 historical/u,
    );
    assert.match(document, /2026-09-05T03:49:25\.000Z/u);
    assert.match(
      document,
      /2026-09-05T17:37:15\+08:00[\s\S]{0,300}2 GiB[\s\S]{0,180}23,545[\s\S]{0,220}`503`[\s\S]{0,160}`BROWSER_RUNTIME_UNAVAILABLE`/u,
    );
    assert.match(
      document,
      /Browser readiness remediation[\s\S]{0,260}`browser-readiness-lifecycle-20260905`[\s\S]{0,160}`0679a0bc510a980f65ebd33eb88b3215a97c20ba`[\s\S]{0,320}browser-readiness-probe\.ts[\s\S]{0,180}browser-readiness-probe\.spec\.ts[\s\S]{0,180}browser-readiness-probe\.smoke\.spec\.ts[\s\S]{0,220}shared wiring[\s\S]{0,180}settlement author[\s\S]{0,180}(?:not deployed|未部署)/u,
    );
    assert.match(
      document,
      /New API[\s\S]{0,260}`65bfc4bff91d2418bd592ff06bf4a2aadbf634a7`[\s\S]{0,120}`C0\/H3\/M1`[\s\S]{0,220}`02c046d76421009b8dd1640a644f597f3d3a009c`[\s\S]{0,120}unreviewed/u,
    );
    assert.match(
      document,
      /Backend settlement consumer[\s\S]{0,260}`c7f6baa58645e5b542da62e85d98fd0584ccf909`[\s\S]{0,140}clean[\s\S]{0,180}82 files[\s\S]{0,180}(?:unreviewed|未独立复核)/u,
    );
    assert.match(
      document,
      /Program C[\s\S]{0,320}A\/B[\s\S]{0,120}(?:pending|待)[\s\S]{0,200}C1-COMPANY first[\s\S]{0,120}(?:recommended|推荐)[\s\S]{0,160}(?:not approved|未批准|未选择)/u,
    );
    assert.match(
      document,
      /3 Release Bundles[\s\S]{0,180}development[\s\S]{0,100}`CANDIDATE`[\s\S]{0,220}`EXTERNAL_UNVERIFIED`[\s\S]{0,160}`NOT_VERIFIED`[\s\S]{0,160}`NOT_REVIEWED`[\s\S]{0,160}`NOT_AUTHORIZED`/u,
    );
    assert.match(
      document,
      /Billing\/Credits[\s\S]{0,120}`DEFERRED \/ NOT_IMPLEMENTED`[\s\S]{0,180}`cap_microusd`[\s\S]{0,160}(?:not|不是)[\s\S]{0,100}(?:balance|余额)/u,
    );
    assert.match(
      document,
      /authorizations remain valid[\s\S]{0,160}original (?:scope|boundaries)[\s\S]{0,220}ordinary local[\s\S]{0,180}Browser helper[\s\S]{0,240}[Nn]ew scope[\s\S]{0,180}merge[\s\S]{0,180}deployment[\s\S]{0,220}(?:corresponding|对应)[\s\S]{0,180}release gate/u,
    );
  };

  assertCurrentStatus(status);
  assert.throws(() =>
    assertCurrentStatus(
      status.replace(
        "An accepted A/B source seam exists",
        "No accepted A/B source seam exists",
      ),
    ),
  );
  assert.throws(() =>
    assertCurrentStatus(
      `${status}\n| GrowthOS current authority | \`541bcc63c3486296ab4e2461d4d005e6cd43710b\` | conflicting current source |\n`,
    ),
  );
  const mutateCurrentStatusRow = (document, prefix, from, to) =>
    document
      .split("\n")
      .map((line) =>
        line.startsWith(`| ${prefix}`) ? line.replace(from, to) : line,
      )
      .join("\n");
  for (const [prefix, from, to] of [
    ["G5-Site — Runtime Observed", "0 current", "1 current"],
    [
      "G5-Site — Runtime Observed",
      "2026-09-05T03:49:25.000Z",
      "2026-09-06T03:49:25.000Z",
    ],
    [
      "G5-Acquisition — Runtime Observed",
      "evidence count=0",
      "evidence count=1",
    ],
    [
      "G5-Acquisition — Runtime Observed",
      "PLATFORM_BUDGET_AUTHORITY_PLATFORM_ACQUISITION_MISSING",
      "ok",
    ],
  ]) {
    assert.throws(() =>
      assertCurrentStatus(mutateCurrentStatusRow(status, prefix, from, to)),
    );
  }
  for (const [from, to] of [
    [
      "0679a0bc510a980f65ebd33eb88b3215a97c20ba",
      "0f72cc104e47128778f2392283a380bc1297f76d",
    ],
    [
      "79e53f391477063404a313d8f8d3f501bcbf40fc",
      "541bcc63c3486296ab4e2461d4d005e6cd43710b",
    ],
    [
      "17e68953ff2e26ac8433db5aa49689e5f9283659",
      "541bcc63c3486296ab4e2461d4d005e6cd43710b",
    ],
    ["4 commits behind", "current with main"],
    ["`RED / HISTORICAL_ONLY`", "`PASS / CURRENT`"],
    ["`RED / NOT_READY`", "`AMBER / PARTIAL`"],
    ["18 advisories", "10 advisories"],
    [
      "Program B root/launcher authority/materialization gate",
      "Program B gate closed",
    ],
    ["CURRENT_MAIN_RED", "CURRENT_MAIN_GREEN"],
    ["SECURITY_SOURCE_CANDIDATE", "SECURITY_MERGED"],
  ]) {
    assert.throws(() => assertCurrentStatus(status.replaceAll(from, to)));
  }

  assert.match(
    architecture,
    /2026-09-04 as-built\/current caveat[\s\S]{0,1000}source identity[\s\S]{0,240}runtime identity[\s\S]{0,500}Program C[\s\S]{0,500}browser ACK[\s\S]{0,300}`0\.0\.0\.0:3001`[\s\S]{0,180}`\*:8080`/u,
  );
  assert.match(
    evidenceIndex,
    /Inventory observed at `2026-09-04T18:[^`]+`[\s\S]{0,240}`6 total \/ 2 current \/ 4 historical`[\s\S]{0,240}`2026-09-05T03:49:25\.000Z`[\s\S]{0,300}Site Builder only[\s\S]{0,220}Acquisition[\s\S]{0,120}0/u,
  );
  assert.match(
    evidenceIndex,
    /3 Release Bundles[\s\S]{0,260}development[\s\S]{0,120}`CANDIDATE`[\s\S]{0,260}`EXTERNAL_UNVERIFIED`/u,
  );
  const assertCurrentChangelog = (document) => {
    assert.match(
      document,
      /## 2026-09-04 · Global dynamic currentness successor[\s\S]{0,1500}0679a0bc510a980f65ebd33eb88b3215a97c20ba[\s\S]{0,500}G5-Site[\s\S]{0,240}G5-Acquisition/u,
    );
    assert.match(
      document,
      /Global dynamic currentness successor[\s\S]{0,1800}accepted source slices #427\/#431\/#432[\s\S]{0,240}active Task0L[\s\S]{0,200}`C3 \/ H3`/u,
    );
  };
  assertCurrentChangelog(changelog);
  for (const [from, to] of [
    ["accepted source slices #427/#431/#432", "unreviewed source slices"],
    ["active Task0L", "completed Task0L"],
    ["`C3 / H3`", "`PASS`"],
  ]) {
    assert.throws(() => assertCurrentChangelog(changelog.replace(from, to)));
  }
});

test("the discovery lineage successor is current-main based and the quarantined mega-branch is provenance only", () => {
  const plan = readFileSync(
    new URL(
      "../docs/superpowers/plans/2026-08-29-discovery-query-lineage-foundation.md",
      import.meta.url,
    ),
    "utf8",
  );
  const conflicts = readFileSync(
    new URL("../docs/governance/conflict-register.md", import.meta.url),
    "utf8",
  );
  const status = readFileSync(
    new URL("../docs/status/current.md", import.meta.url),
    "utf8",
  );
  const releasePlan = readFileSync(
    new URL("../docs/roadmap/release-plan.md", import.meta.url),
    "utf8",
  );
  const closeoutPlan = readFileSync(
    new URL(
      "../docs/superpowers/plans/2026-08-30-discovery-lineage-g0-closeout.md",
      import.meta.url,
    ),
    "utf8",
  );
  for (const required of [
    "c7e39e050b2f30ed9ff155aec139ff206fb850d0",
    "codex/discovery-query-materialization-successor",
    "NON_DEPLOYABLE / PROVENANCE_ONLY",
    "no-product-code boundary",
  ]) {
    assert.match(plan, new RegExp(required.replaceAll("/", "\\/")));
  }
  assert.match(plan, /DISCOVERY_GOVERNED_LINEAGE_NOT_READY/);
  for (const required of [
    "d2c93dd6bea0348381286558896b395c84945171",
    "codex/discovery-lineage-g0-closeout",
    "ZERO_PRODUCT_CODE",
    "DISCOVERY_GOVERNED_LINEAGE_NOT_READY",
    "stops after a locally reviewed commit",
  ]) {
    assert.match(closeoutPlan, new RegExp(required));
  }

  const expectedCard =
    "| `GPP-B-LINEAGE-001` | `ADMITTED / ZERO_PRODUCT_CODE / CURRENT_MAIN_READBACK_PASS` | `codex/discovery-query-materialization-successor` | initial base=`c7e39e050b2f30ed9ff155aec139ff206fb850d0`；PR #425 merge/readback=`d2c93dd6bea0348381286558896b395c84945171`；scope 仍仅为 Program B ACK identity、index-preserving Raw resolution 与 Provider-owned company lineage。旧 A mega-branch 继续 `NON_DEPLOYABLE / PROVENANCE_ONLY`；G0 ownership 已关闭，但本卡不授权 G2/G3 产品实现。 |";
  const assertUniqueDiscoveryLineageCard = (document) => {
    const rows = document
      .split("\n")
      .filter((line) => line.startsWith("| `GPP-B-LINEAGE-001` |"));
    assert.deepEqual(rows, [expectedCard]);
  };
  assertUniqueDiscoveryLineageCard(conflicts);
  assert.match(
    conflicts,
    /> 当前工程核验基线：`origin\/main@d2c93dd6bea0348381286558896b395c84945171`；Program A historical delta-audit base=`23d111f7b400403deb7466abf34ab709685b8376`/,
  );
  for (const mutation of [
    ["ZERO_PRODUCT_CODE", "PRODUCT_CODE"],
    ["codex/discovery-query-materialization-successor", "codex/other-writer"],
    ["c7e39e050b2f30ed9ff155aec139ff206fb850d0", "b".repeat(40)],
    [
      "scope 仍仅为 Program B ACK identity",
      "scope 扩大为 Program A ACK identity",
    ],
    ["CURRENT_MAIN_READBACK_PASS", "IMPLEMENTATION_AUTHORIZED"],
    ["d2c93dd6bea0348381286558896b395c84945171", "d".repeat(40)],
  ]) {
    assert.throws(() =>
      assertUniqueDiscoveryLineageCard(
        conflicts.replace(
          expectedCard,
          expectedCard.replace(mutation[0], mutation[1]),
        ),
      ),
    );
  }

  const expectedProgramBRow =
    "| B — Buyer Intelligence discovery | RED | Owns QueryReceipt、RawSourceRecord、Identity/Canonical、Provider/transport、Discovery workflow 和 immutable `LeadQualifiedPackage`；does not own SaaS Opportunity or runtime deploy | #427/#431/#432 accepted main slices 与 active Task0L 分开；latest reviewed `f3e5bc19…` remains `C6/H5`，live `7b983959…` is dirty/unreviewed，Task 0P、Phase A/B、packet/root/0A are closed. |";
  const expectedG0Row =
    "| G0 — Truth & Ownership | `AMBER / PARTIAL / HOLD` | A/B ownership seam 已关闭；Program B root/launcher authority/materialization gate、platform R2 writer/migration manifest 与 Program C 产品选择/owner/manifest 仍未闭合。 |";
  const normalizeTableRow = (line) =>
    line
      .split("|")
      .map((cell) => cell.trim())
      .join(" | ");
  const statusRowLabel = (prefix) => prefix.trimEnd().replace(/\s*\|$/, "");
  const assertUniqueStatusRow = (document, prefix, expected) => {
    const rows = document
      .split("\n")
      .filter((line) => line.startsWith(statusRowLabel(prefix)));
    assert.deepEqual(rows.map(normalizeTableRow), [
      normalizeTableRow(expected),
    ]);
  };
  const mutateStatusRow = (document, prefix, from, to) =>
    document
      .split("\n")
      .map((line) =>
        line.startsWith(statusRowLabel(prefix)) ? line.replace(from, to) : line,
      )
      .join("\n");
  assertUniqueStatusRow(
    status,
    "| B — Buyer Intelligence discovery |",
    expectedProgramBRow,
  );
  assertUniqueStatusRow(status, "| G0 — Truth & Ownership |", expectedG0Row);
  const expectedProgramARow =
    "| A — authority/runtime primitives | AMBER | Owns generic Execution Authority, GovernedSubject/Relation primitives, Site Quote/Grant, OCI/runtime and RuntimeEvidence/Release；does not own Raw/Identity/Provider/Opportunity | Accepted main slices 与 historical mega branch 分离；platform R2 owner/manifest 和 current exact-head review 尚未闭合。 |";
  const expectedRootRow =
    "| `/global/backend` root `main` | observed `2026-09-05T18:19:59+08:00`：`HEAD=origin/main=0679a0bc510a980f65ebd33eb88b3215a97c20ba`；仅保留既有未跟踪 `.playwright-cli/` | Git source observation；不是 runtime identity；PR #448 checks complete does not change main. |";
  assertUniqueStatusRow(
    status,
    "| A — authority/runtime primitives |",
    expectedProgramARow,
  );
  assertUniqueStatusRow(
    status,
    "| `/global/backend` root `main` |",
    expectedRootRow,
  );
  for (const [expected, prefix, mutations] of [
    [
      expectedProgramBRow,
      "| B — Buyer Intelligence discovery |",
      [
        ["`C6/H5`", "`C0/H0`"],
        ["dirty/unreviewed", "clean/accepted"],
      ],
    ],
    [
      expectedG0Row,
      "| G0 — Truth & Ownership |",
      [
        ["`AMBER / PARTIAL / HOLD`", "`PASS / OWNERSHIP_CLOSED`"],
        [
          "Program B root/launcher authority/materialization gate",
          "Program B gate closed",
        ],
        ["platform R2 writer/migration manifest", "platform R2 complete"],
        ["Program C 产品选择/owner/manifest", "Program C complete"],
      ],
    ],
  ]) {
    for (const [from, to] of mutations) {
      assert.throws(() =>
        assertUniqueStatusRow(
          mutateStatusRow(status, prefix, from, to),
          prefix,
          expected,
        ),
      );
    }
  }
  for (const [expected, prefix, mutation] of [
    [
      expectedProgramARow,
      "| A — authority/runtime primitives |",
      ["historical mega branch", "accepted mega branch"],
    ],
    [
      expectedRootRow,
      "| `/global/backend` root `main` |",
      [
        "0679a0bc510a980f65ebd33eb88b3215a97c20ba",
        "0f72cc104e47128778f2392283a380bc1297f76d",
      ],
    ],
  ]) {
    assert.throws(() =>
      assertUniqueStatusRow(
        mutateStatusRow(status, prefix, mutation[0], mutation[1]),
        prefix,
        expected,
      ),
    );
  }
  assert.match(status, /> 最后核验：2026-09-05T/);
  assert.match(
    status,
    /Development runtime identity is `674ff12d4d768ce5599fc07b565fe21da37dc5fe`, 4 commits behind repository source/,
  );
  const expectedConflictRow =
    "| `CON-GPP-001` | Program A Task 5.2 与 Program B 的 Raw/Identity/Canonical/Discovery ownership 重叠。 | `RESOLVED_WITH_REMEDIATION` | `OWN-PRODUCT` | PR #424 固定 owner/seam 与 mega-branch `NON_DEPLOYABLE / PROVENANCE_ONLY` disposition；PR #425 merge/readback `d2c93dd6bea0348381286558896b395c84945171` 将唯一 `GPP-B-LINEAGE-001` card/writer 写入 current main。ownership collision 已关闭；四个 Task 5.2 commits 与五个 B-owned deltas 继续按 ADR-025 分类，G2/G3 产品实现仍未接纳。 |";
  const expectedBlockerRow =
    "| `BLK-GPP-001` | Ownership/provenance collision 已由 PR #424 与 PR #425 current-main readback 关闭。 | `OWN-PRODUCT` | `RESOLVED` at `main@d2c93dd6bea0348381286558896b395c84945171`；若 Program A head/index/worktree/merge 移动、出现第二 writer/card、或隔离提交进入 successor/migration/deploy，则重新打开 G0。 | `RESOLVED`；不授权 Discovery 产品实现，后续仍受 G2/G3、费用、runtime 与发布门约束。 |";
  assertUniqueStatusRow(conflicts, "| `CON-GPP-001` |", expectedConflictRow);
  assertUniqueStatusRow(conflicts, "| `BLK-GPP-001` |", expectedBlockerRow);
  for (const [expected, prefix, mutation] of [
    [
      expectedConflictRow,
      "| `CON-GPP-001` |",
      ["RESOLVED_WITH_REMEDIATION", "HOLD_OWNERSHIP"],
    ],
    [
      expectedBlockerRow,
      "| `BLK-GPP-001` |",
      ["`RESOLVED`", "`HOLD_OWNERSHIP`"],
    ],
  ]) {
    assert.throws(() =>
      assertUniqueStatusRow(
        conflicts.replace(expected, expected.replace(mutation[0], mutation[1])),
        prefix,
        expected,
      ),
    );
  }
  const phase0Rows = releasePlan
    .split("\n")
    .filter((line) => line.startsWith("1. **Phase 0"));
  const expectedPhase0Row =
    "1. **Phase 0 — Truth and ownership:** establish current authority, Program A/B/C ownership and accepted interfaces before any product implementation; live completion and merge/readback facts remain in [current status](../status/current.md).";
  assert.deepEqual(phase0Rows, [expectedPhase0Row]);
  const releaseG0Rows = releasePlan
    .split("\n")
    .filter((line) => /^\|\s*G0 — Truth & Ownership\s*\|/.test(line))
    .map(normalizeTableRow);
  assert.deepEqual(releaseG0Rows, [
    normalizeTableRow(
      "| G0 — Truth & Ownership | Binding plans, current authority, single-writer ownership, schema/migration boundaries and accepted seams are explicit. |",
    ),
  ]);
  const laterGateRows = status
    .split("\n")
    .filter((line) =>
      /^\| G(?:[1-4]|5-(?:Site|Acquisition)|[6-7]) —/.test(line),
    );
  assert.equal(laterGateRows.length, 8);
  assert.match(laterGateRows.join("\n"), /G3[^\n]*`RED \/ NOT_INTEGRATED`/);
  assert.match(
    laterGateRows.join("\n"),
    /G5-Site[^\n]*`RED \/ HISTORICAL_ONLY`/,
  );
  assert.match(
    laterGateRows.join("\n"),
    /G5-Acquisition[^\n]*`RED \/ NOT_READY`/,
  );
});

function issueCodes(result) {
  return result.issues.map((issue) => issue.code);
}

function runtimeEvidence(overrides = {}) {
  return {
    schema_version: "runtime-evidence/v1",
    evidence_id: "runtime-api-development-20260807",
    commit: SHA_A,
    environment: "development",
    verified_at: "2026-08-07T01:00:00.000Z",
    valid_until: "2026-08-08T01:00:00.000Z",
    evidence_kind: "runtime_probe",
    result: "PASS",
    artifact_digest: DIGEST,
    ...overrides,
  };
}

function releaseEvidence(overrides = {}) {
  return runtimeEvidence({
    commit: SHA_D,
    environment: "pilot",
    verified_at: "2026-08-07T10:26:00.000Z",
    valid_until: "2026-08-08T10:26:00.000Z",
    ...overrides,
  });
}

function provider(overrides = {}) {
  return {
    key: "public_web",
    status: "IMPLEMENTED",
    source_classes: ["public_intelligence"],
    purpose: "Discover public company facts from bounded web search and crawl.",
    taxonomy: ["ICP industry and product terms"],
    license: {
      classification: "SOURCE_SPECIFIC",
      note: "Preserve source provenance and terms; no blanket content licence.",
    },
    personal_data_class: "RESTRICTED_POSSIBLE",
    default_enablement: "ENABLED",
    call_gates: ["source_policy", "egress_guard", "tool_broker"],
    test_paths: [
      "apps/api/src/discovery/providers/public-web.provider.spec.ts",
    ],
    evidence_refs: [
      {
        kind: "TEST_ANCHOR",
        path: "apps/api/src/discovery/providers/public-web.provider.spec.ts",
      },
    ],
    ...overrides,
  };
}

function providerRegistry(overrides = {}) {
  return {
    schema_version: "provider-registry/v1",
    generated_document: "docs/backend/provider-registry.md",
    providers: [provider()],
    ...overrides,
  };
}

function releaseBundle(overrides = {}) {
  return {
    schema_version: "release-bundle/v1",
    release_id: "buyer-pilot-20260807",
    release_status: "PILOT",
    environment: "pilot",
    release_owner: "OWN-BUYER-BE",
    implementation_commit: SHA_D,
    released_at: "2026-08-07T10:30:00.000Z",
    capability_ids: ["CAP-BUYER-001"],
    external_provenance: {
      status: "EXTERNAL_UNVERIFIED",
      verifier: "NONE",
      verification_ref: "NONE",
    },
    traceability_bindings: [
      {
        chain_id: "buyer-discovery-pilot",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["runtime-api-development-20260807"],
      },
    ],
    scope: {
      included: ["bounded buyer discovery"],
      excluded: ["campaigns and outreach"],
    },
    promise: {
      user_outcome: "A reviewer can inspect explainable buyer candidates.",
      non_guarantees: ["No automated outreach."],
    },
    source: {
      repository: "mlhjyx/global-backend",
      base_commit: SHA_A,
      source_head: SHA_B,
    },
    evidence_ids: ["runtime-api-development-20260807"],
    operations: {
      runbook: "docs/backend/runbook.md",
      observability: "runtime evidence is digest-bound",
    },
    data: {
      classification: "company facts plus restricted contact data",
      retention: "source-specific",
    },
    rollback_and_exit: {
      trigger: "quality or policy gate fails",
      procedure: "disable the pilot route and preserve receipts",
    },
    guides: ["docs/README.md"],
    approval: {
      machine: {
        status: "PASS",
        provenance: "CHECK_RUN",
        evidence_ref: "https://github.example/checks/1",
        verified_at: "2026-08-07T10:00:00.000Z",
      },
      reviewer: {
        status: "APPROVED",
        provenance: "GITHUB_REVIEW",
        evidence_ref: "https://github.example/reviews/2",
        actor: "independent-reviewer",
        reviewed_at: "2026-08-07T10:10:00.000Z",
      },
      user_authorization: {
        status: "AUTHORIZED",
        provenance: "SIGNED_AUTHORIZATION",
        evidence_ref: "https://github.example/authorizations/3",
        actor: "product-owner",
        authorized_at: "2026-08-07T10:20:00.000Z",
      },
    },
    merge_evidence: {
      method: "MERGE_COMMIT",
      base_commit: SHA_A,
      source_head: SHA_B,
      result_commit: SHA_D,
      parent_commits: [SHA_A, SHA_B],
      merged_at: "2026-08-07T10:25:00.000Z",
    },
    learning: {
      owner: "OWN-BUYER-BE",
      review_at: "2026-08-14T10:30:00.000Z",
      success_measure: "reviewer acceptance and zero policy bypasses",
    },
    ...overrides,
  };
}

function traceability(overrides = {}) {
  return {
    schema_version: "delivery-traceability/v1",
    chains: [
      {
        chain_id: "buyer-discovery-pilot",
        capability_id: "CAP-BUYER-001",
        object_ids: ["OBJ-FE-009", "OBJ-FE-010"],
        operation_ids: ["DiscoveryController_execute_v1"],
        code_paths: ["apps/api/src/discovery/discovery.controller.ts"],
        test_paths: ["apps/api/src/discovery/discovery.service.spec.ts"],
        scenario_ids: ["SCN-FE-BUYER-001"],
        delivery_state: "PILOT",
        evidence_ids: ["runtime-api-development-20260807"],
        required_evidence_kinds: ["runtime_probe"],
      },
    ],
    ...overrides,
  };
}

function releaseValidationContext(overrides = {}) {
  const chain = traceability().chains[0];
  return {
    evidence_by_id: new Map([
      ["runtime-api-development-20260807", releaseEvidence()],
    ]),
    traceability_by_id: new Map([[chain.chain_id, chain]]),
    now: NOW,
    ...overrides,
  };
}

function traceabilityContext(overrides = {}) {
  return {
    capability_ids: new Set(["CAP-BUYER-001"]),
    object_ids: new Set(["OBJ-FE-009", "OBJ-FE-010"]),
    operation_ids: new Set(["DiscoveryController_execute_v1"]),
    scenario_ids: new Set(["SCN-FE-BUYER-001"]),
    existing_paths: new Set([
      "apps/api/src/discovery/discovery.controller.ts",
      "apps/api/src/discovery/discovery.service.spec.ts",
    ]),
    evidence_by_id: new Map([
      ["runtime-api-development-20260807", runtimeEvidence()],
    ]),
    release_bundles_by_capability: new Map([
      ["CAP-BUYER-001", [releaseBundle()]],
    ]),
    now: NOW,
    ...overrides,
  };
}

test("runtime evidence is current only inside its explicit validity window", () => {
  const current = validateRuntimeEvidence(runtimeEvidence(), { now: NOW });
  assert.deepEqual(current.issues, []);
  assert.equal(current.classification, "CURRENT");

  const expired = validateRuntimeEvidence(runtimeEvidence(), {
    now: new Date("2026-08-08T01:00:00.000Z"),
  });
  assert.deepEqual(expired.issues, []);
  assert.equal(expired.classification, "HISTORICAL");
  assert.equal(expired.eligible_for_promotion, false);
});

test("runtime evidence rejects missing identity and non-SHA-256 artifacts", () => {
  const result = validateRuntimeEvidence(
    runtimeEvidence({ commit: undefined, artifact_digest: "latest" }),
    { now: NOW },
  );
  assert.deepEqual(
    new Set(issueCodes(result)),
    new Set(["EVIDENCE_COMMIT_INVALID", "EVIDENCE_DIGEST_INVALID"]),
  );
});

test("runtime evidence rejects artifact paths outside the repository", () => {
  for (const artifactPath of [
    "/etc/passwd",
    "../outside.json",
    "docs/evidence/../../outside.json",
  ]) {
    const result = validateRuntimeEvidence(
      runtimeEvidence({ artifact_path: artifactPath }),
      { now: NOW },
    );
    assert.ok(
      issueCodes(result).includes("EVIDENCE_ARTIFACT_PATH_INVALID"),
      artifactPath,
    );
    assert.equal(result.classification, "INVALID");
  }
});

test("runtime evidence cannot self-authorize an unbounded freshness window", () => {
  const result = validateRuntimeEvidence(
    runtimeEvidence({ valid_until: "2026-08-08T01:00:00.001Z" }),
    { now: NOW },
  );
  assert.ok(issueCodes(result).includes("EVIDENCE_WINDOW_TOO_LONG"));
  assert.equal(result.eligible_for_promotion, false);
});

test("provider registry is bound to code-seeded key, SourceClass, and enablement", () => {
  const context = {
    seed_providers: [
      {
        key: "public_web",
        source_class: "public_intelligence",
        default_enablement: "ENABLED",
      },
    ],
    source_class_manifest: {
      public_web: ["public_intelligence"],
    },
    existing_paths: new Set([
      "apps/api/src/discovery/providers/public-web.provider.spec.ts",
    ]),
  };
  assert.deepEqual(
    validateProviderRegistry(providerRegistry(), context).issues,
    [],
  );

  const mutant = providerRegistry({
    providers: [provider({ source_classes: ["company_registry"] })],
  });
  assert.ok(
    issueCodes(validateProviderRegistry(mutant, context)).includes(
      "PROVIDER_SOURCE_CLASS_DRIFT",
    ),
  );
  const extraClassMutant = providerRegistry({
    providers: [
      provider({
        source_classes: ["public_intelligence", "bogus_unrouted_class"],
      }),
    ],
  });
  assert.ok(
    issueCodes(validateProviderRegistry(extraClassMutant, context)).includes(
      "PROVIDER_SOURCE_CLASS_DRIFT",
    ),
  );
  const missingClassMutant = providerRegistry({
    providers: [provider({ source_classes: ["public_intelligence"] })],
  });
  assert.ok(
    issueCodes(
      validateProviderRegistry(missingClassMutant, {
        ...context,
        source_class_manifest: {
          public_web: ["public_intelligence", "industry_data"],
        },
      }),
    ).includes("PROVIDER_SOURCE_CLASS_DRIFT"),
  );
  const disabledMutant = providerRegistry({
    providers: [provider({ default_enablement: "DISABLED" })],
  });
  assert.ok(
    issueCodes(validateProviderRegistry(disabledMutant, context)).includes(
      "PROVIDER_ENABLEMENT_DRIFT",
    ),
  );
  const missingEvidenceMutant = providerRegistry({
    providers: [
      provider({
        evidence_refs: [
          { kind: "TEST_ANCHOR", path: "apps/api/src/missing.spec.ts" },
        ],
      }),
    ],
  });
  assert.ok(
    issueCodes(
      validateProviderRegistry(missingEvidenceMutant, context),
    ).includes("PROVIDER_EVIDENCE_MISSING"),
  );
});

test("provider seed parsing tolerates formatting but fails closed when no seed can be read", () => {
  const source = `
    create: {
      status: "ENABLED",
      costPerCallCents: 0,
      class: "industry_data",
      key: "directory"
    }
  `;
  assert.deepEqual(parseSeedProviders(source), [
    {
      key: "directory",
      source_class: "industry_data",
      default_enablement: "ENABLED",
    },
  ]);
  const validation = validateProviderRegistry(providerRegistry(), {
    seed_providers: [],
    source_class_manifest: {
      public_web: ["public_intelligence"],
    },
    existing_paths: new Set([
      "apps/api/src/discovery/providers/public-web.provider.spec.ts",
    ]),
  });
  assert.ok(issueCodes(validation).includes("PROVIDER_SEED_PARSE_EMPTY"));
});

test("provider human documentation is deterministic and exposes every governance field", () => {
  const rendered = renderProviderRegistry(providerRegistry());
  assert.match(rendered, /# Provider Registry/);
  assert.match(rendered, /public_web/);
  assert.match(rendered, /public_intelligence/);
  assert.match(rendered, /Personal data class/);
  assert.match(rendered, /Call gates/);
  assert.equal(rendered, renderProviderRegistry(providerRegistry()));
});

test("traceability requires every registry, contract, code, test, scenario, evidence, and bundle link", () => {
  assert.deepEqual(
    validateTraceability(traceability(), traceabilityContext()).issues,
    [],
  );

  const chain = traceability().chains[0];
  const mutants = [
    [
      { ...chain, capability_id: "CAP-MISSING-001" },
      "TRACE_CAPABILITY_MISSING",
    ],
    [{ ...chain, object_ids: ["OBJ-FE-999"] }, "TRACE_OBJECT_MISSING"],
    [
      { ...chain, operation_ids: ["Missing_operation"] },
      "TRACE_OPERATION_MISSING",
    ],
    [
      { ...chain, code_paths: ["apps/api/src/missing.ts"] },
      "TRACE_CODE_MISSING",
    ],
    [
      { ...chain, test_paths: ["apps/api/src/missing.spec.ts"] },
      "TRACE_TEST_MISSING",
    ],
    [
      { ...chain, scenario_ids: ["SCN-FE-MISSING-001"] },
      "TRACE_SCENARIO_MISSING",
    ],
  ];
  for (const [mutant, expected] of mutants) {
    const result = validateTraceability(
      { ...traceability(), chains: [mutant] },
      traceabilityContext(),
    );
    assert.ok(issueCodes(result).includes(expected), expected);
  }
});

test("pilot traceability fails closed on expired evidence or an absent Release Bundle", () => {
  const staleEvidence = runtimeEvidence({
    valid_until: "2026-08-07T11:59:59.000Z",
  });
  const stale = validateTraceability(
    traceability(),
    traceabilityContext({
      evidence_by_id: new Map([[staleEvidence.evidence_id, staleEvidence]]),
    }),
  );
  assert.ok(issueCodes(stale).includes("TRACE_FRESH_EVIDENCE_REQUIRED"));

  const noBundle = validateTraceability(
    traceability(),
    traceabilityContext({ release_bundles_by_capability: new Map() }),
  );
  assert.ok(issueCodes(noBundle).includes("TRACE_RELEASE_BUNDLE_REQUIRED"));
});

test("pilot traceability binds the required evidence kind and exact Release Bundle chain", () => {
  const wrongKind = runtimeEvidence({ evidence_kind: "generic_smoke" });
  const wrongKindResult = validateTraceability(
    traceability(),
    traceabilityContext({
      evidence_by_id: new Map([[wrongKind.evidence_id, wrongKind]]),
    }),
  );
  assert.ok(
    issueCodes(wrongKindResult).includes("TRACE_EVIDENCE_KIND_UNEXPECTED"),
  );
  assert.ok(
    issueCodes(wrongKindResult).includes("TRACE_FRESH_EVIDENCE_REQUIRED"),
  );

  const wrongBinding = releaseBundle({
    traceability_bindings: [
      {
        chain_id: "another-chain",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["runtime-api-development-20260807"],
      },
    ],
  });
  const wrongBindingResult = validateTraceability(
    traceability(),
    traceabilityContext({
      release_bundles_by_capability: new Map([
        ["CAP-BUYER-001", [wrongBinding]],
      ]),
    }),
  );
  assert.ok(
    issueCodes(wrongBindingResult).includes("TRACE_RELEASE_BUNDLE_REQUIRED"),
  );

  const wrongEvidence = releaseBundle({
    traceability_bindings: [
      {
        chain_id: "buyer-discovery-pilot",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["other-evidence"],
      },
    ],
  });
  const wrongEvidenceResult = validateTraceability(
    traceability(),
    traceabilityContext({
      release_bundles_by_capability: new Map([
        ["CAP-BUYER-001", [wrongEvidence]],
      ]),
    }),
  );
  assert.ok(
    issueCodes(wrongEvidenceResult).includes("TRACE_RELEASE_BUNDLE_REQUIRED"),
  );
});

test("internal-only traceability preserves missing runtime proof without pretending pilot readiness", () => {
  const internal = {
    ...traceability(),
    chains: [
      {
        ...traceability().chains[0],
        delivery_state: "INTERNAL_ONLY",
        evidence_ids: [],
      },
    ],
  };
  assert.deepEqual(
    validateTraceability(
      internal,
      traceabilityContext({ release_bundles_by_capability: new Map() }),
    ).issues,
    [],
  );
});

test("Release Bundle keeps decision lanes separate but documentary until external readback", () => {
  const context = releaseValidationContext();
  assert.deepEqual(
    issueCodes(validateReleaseBundle(releaseBundle(), context)),
    ["RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED"],
  );
  assert.deepEqual(
    validateDecisionGateSeparation(releaseBundle().approval).issues,
    [],
  );

  const flattened = {
    ...releaseBundle().approval,
    user_authorization: {
      ...releaseBundle().approval.user_authorization,
      provenance: "PR_BODY_DECLARATION",
    },
  };
  assert.ok(
    issueCodes(validateDecisionGateSeparation(flattened)).includes(
      "AUTHORIZATION_PROVENANCE_UNTRUSTED",
    ),
  );
});

test("forged external URLs and VERIFIED strings cannot promote a Release Bundle", () => {
  const forged = releaseBundle({
    external_provenance: {
      status: "VERIFIED",
      verifier: "INDEPENDENT_EXTERNAL_READBACK",
      verification_ref: "https://attacker.invalid/readback",
    },
    approval: {
      machine: {
        ...releaseBundle().approval.machine,
        evidence_ref: "https://attacker.invalid/check",
      },
      reviewer: {
        ...releaseBundle().approval.reviewer,
        evidence_ref: "https://attacker.invalid/review",
      },
      user_authorization: {
        ...releaseBundle().approval.user_authorization,
        evidence_ref: "https://attacker.invalid/authorization",
      },
    },
  });
  const result = validateReleaseBundle(forged, releaseValidationContext());
  assert.ok(
    issueCodes(result).includes("RELEASE_EXTERNAL_PROVENANCE_UNVERIFIED"),
  );
  assert.ok(
    issueCodes(result).includes("RELEASE_EXTERNAL_PROVENANCE_UNSUPPORTED"),
  );
});

test("Release Bundle rejects one artifact reused as all three decision gates", () => {
  const approval = structuredClone(releaseBundle().approval);
  approval.reviewer.evidence_ref = approval.machine.evidence_ref;
  approval.user_authorization.evidence_ref = approval.machine.evidence_ref;
  const result = validateDecisionGateSeparation(approval);
  assert.ok(issueCodes(result).includes("DECISION_GATE_EVIDENCE_CONFLATED"));
});

test("merge-method evidence proves the result shape instead of naming a method only", () => {
  assert.deepEqual(
    validateMergeEvidence(releaseBundle().merge_evidence).issues,
    [],
  );

  const mutant = {
    ...releaseBundle().merge_evidence,
    parent_commits: [SHA_A],
  };
  assert.ok(
    issueCodes(validateMergeEvidence(mutant)).includes(
      "MERGE_COMMIT_PARENTS_INVALID",
    ),
  );
});

test("Release Bundle rendering is deterministic and includes every review section", () => {
  const rendered = renderReleaseBundle(releaseBundle());
  for (const heading of [
    "Identity",
    "Scope",
    "Promise",
    "Source",
    "Evidence",
    "External provenance",
    "Operations",
    "Data",
    "Rollback and exit",
    "Guides",
    "Approval",
    "Learning",
  ]) {
    assert.match(rendered, new RegExp(`## ${heading}`));
  }
  assert.equal(rendered, renderReleaseBundle(releaseBundle()));
});

test("a copied Release Bundle template cannot be accepted as a real bundle", () => {
  const mutant = releaseBundle({ release_id: "REPLACE_WITH_RELEASE_ID" });
  const result = validateReleaseBundle(mutant, releaseValidationContext());
  assert.ok(issueCodes(result).includes("RELEASE_PLACEHOLDER_PRESENT"));
});

test("Release Bundle binds every capability to a traceability chain and the same evidence set", () => {
  const context = releaseValidationContext();
  const missingChain = releaseBundle({ traceability_bindings: [] });
  assert.ok(
    issueCodes(validateReleaseBundle(missingChain, context)).includes(
      "RELEASE_TRACEABILITY_REQUIRED",
    ),
  );

  const unboundEvidence = releaseBundle({
    traceability_bindings: [
      {
        chain_id: "buyer-discovery-pilot",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["different-evidence"],
      },
    ],
  });
  assert.ok(
    issueCodes(validateReleaseBundle(unboundEvidence, context)).includes(
      "RELEASE_TRACEABILITY_EVIDENCE_UNBOUND",
    ),
  );

  const missingRegistryChain = releaseBundle({
    traceability_bindings: [
      {
        chain_id: "not-in-traceability-registry",
        capability_id: "CAP-BUYER-001",
        evidence_ids: ["runtime-api-development-20260807"],
      },
    ],
  });
  assert.ok(
    issueCodes(validateReleaseBundle(missingRegistryChain, context)).includes(
      "RELEASE_TRACEABILITY_CHAIN_MISSING",
    ),
  );
});

test("required-context policy fails when a repository workflow drops a named context", () => {
  const setupNodeRevision = "820762786026740c76f36085b0efc47a31fe5020";
  const codeowners = [
    "# ordinary ownership",
    "/apps/api/src/auth/ @mlhjyx",
    "# terminal governance ownership block",
    "/.github/ @mlhjyx",
    "/.gitleaks.toml @mlhjyx",
    "/.gitleaksignore @mlhjyx",
    "/docs/governance/ @mlhjyx",
    "/package.json @mlhjyx",
    "/scripts/governance-*.mjs @mlhjyx",
  ].join("\n");
  const policy = {
    schema_version: "required-contexts/v1",
    required_contexts: [
      "build · typecheck · test",
      "governance · traceability · release",
    ],
    context_implementations: [
      {
        name: "build · typecheck · test",
        workflow: ".github/workflows/ci.yml",
        event: "pull_request",
      },
      {
        name: "governance · traceability · release",
        workflow: ".github/workflows/governance.yml",
        event: "pull_request",
      },
    ],
    workflow_runtime_requirements: [
      { workflow: ".github/workflows/governance.yml", node_major: 22 },
    ],
    workflow_action_pins: [
      {
        workflow: ".github/workflows/governance.yml",
        action: "actions/setup-node",
        revision: setupNodeRevision,
        version: "v7",
      },
    ],
    codeowner_requirements: {
      owner: "@mlhjyx",
      terminal_patterns: [
        "/.github/",
        "/.gitleaks.toml",
        "/.gitleaksignore",
        "/docs/governance/",
        "/package.json",
        "/scripts/governance-*.mjs",
      ],
    },
    external_ruleset_requirements: {
      required_approving_reviews: 1,
      require_code_owner_review: true,
      dismiss_stale_reviews: true,
      require_conversation_resolution: true,
      allow_force_push: false,
      allow_deletion: false,
      user_authorization: "separate signed authorization",
      merge_evidence: "record the actual merge method",
    },
  };
  const workflows = new Map([
    [
      ".github/workflows/ci.yml",
      "on:\n  pull_request:\njobs:\n  build:\n    name: build · typecheck · test\n",
    ],
    [
      ".github/workflows/governance.yml",
      `on:\n  pull_request:\njobs:\n  governance:\n    name: governance · traceability · release\n    steps:\n      - uses: actions/setup-node@${setupNodeRevision} # v7\n        with:\n          node-version: 22\n`,
    ],
  ]);
  const repositoryContext = { codeowners };
  assert.deepEqual(
    validateRequiredContexts(policy, workflows, repositoryContext).issues,
    [],
  );

  for (const condition of [
    "false",
    "contains(github.event.pull_request.labels.*.name, 'run-ci')",
  ]) {
    const conditional = new Map(workflows);
    conditional.set(
      ".github/workflows/ci.yml",
      `on:\n  pull_request:\njobs:\n  build:\n    if: ${condition}\n    name: build · typecheck · test\n`,
    );
    assert.ok(
      issueCodes(
        validateRequiredContexts(policy, conditional, repositoryContext),
      ).includes("REQUIRED_CONTEXT_JOB_CONDITIONAL"),
      condition,
    );
  }

  const approvedCondition =
    "github.event.pull_request.base.ref == github.event.repository.default_branch";
  const conditionPolicy = {
    ...policy,
    context_implementations: policy.context_implementations.map((item) =>
      item.name === "build · typecheck · test"
        ? { ...item, allowed_job_if: approvedCondition }
        : item,
    ),
  };
  const approvedConditional = new Map(workflows);
  approvedConditional.set(
    ".github/workflows/ci.yml",
    `on:\n  pull_request:\njobs:\n  build:\n    if: ${approvedCondition}\n    name: build · typecheck · test\n`,
  );
  const approvedConditionalCodes = issueCodes(
    validateRequiredContexts(
      conditionPolicy,
      approvedConditional,
      repositoryContext,
    ),
  );
  assert.ok(
    !approvedConditionalCodes.includes("REQUIRED_CONTEXT_JOB_CONDITIONAL"),
  );
  assert.ok(
    !approvedConditionalCodes.includes("REQUIRED_CONTEXT_JOB_CONDITION_DRIFT"),
  );
  approvedConditional.set(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\njobs:\n  build:\n    if: false\n    name: build · typecheck · test\n",
  );
  const driftedConditionalCodes = issueCodes(
    validateRequiredContexts(
      conditionPolicy,
      approvedConditional,
      repositoryContext,
    ),
  );
  assert.ok(
    driftedConditionalCodes.includes("REQUIRED_CONTEXT_JOB_CONDITIONAL"),
  );
  assert.ok(
    driftedConditionalCodes.includes("REQUIRED_CONTEXT_JOB_CONDITION_DRIFT"),
  );

  const conditionalDependency = new Map(workflows);
  conditionalDependency.set(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\njobs:\n  optional:\n    if: false\n    name: optional\n  build:\n    needs: optional\n    name: build · typecheck · test\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(
        policy,
        conditionalDependency,
        repositoryContext,
      ),
    ).includes("REQUIRED_CONTEXT_NEEDS_UNPROTECTED"),
  );

  const continueOnError = new Map(workflows);
  continueOnError.set(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\njobs:\n  build:\n    name: build · typecheck · test\n    continue-on-error: true\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, continueOnError, repositoryContext),
    ).includes("REQUIRED_CONTEXT_CONTINUE_ON_ERROR"),
  );

  const duplicateContext = new Map(workflows);
  duplicateContext.set(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\njobs:\n  build-a:\n    name: build · typecheck · test\n  build-b:\n    name: build · typecheck · test\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, duplicateContext, repositoryContext),
    ).includes("REQUIRED_CONTEXT_JOB_AMBIGUOUS"),
  );

  workflows.delete(".github/workflows/governance.yml");
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, workflows, repositoryContext),
    ).includes("REQUIRED_CONTEXT_NOT_IMPLEMENTED"),
  );

  const stepOnly = new Map([
    [
      ".github/workflows/ci.yml",
      "on:\n  pull_request:\njobs:\n  build:\n    name: build · typecheck · test\n    steps:\n      - name: governance · traceability · release\n",
    ],
  ]);
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, stepOnly, repositoryContext),
    ).includes("REQUIRED_CONTEXT_NOT_IMPLEMENTED"),
  );

  const noPullRequest = new Map(workflows);
  noPullRequest.set(
    ".github/workflows/governance.yml",
    "on:\n  workflow_dispatch:\njobs:\n  governance:\n    name: governance · traceability · release\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, noPullRequest, repositoryContext),
    ).includes("REQUIRED_CONTEXT_EVENT_MISSING"),
  );

  const unsafeRuleset = {
    ...policy,
    external_ruleset_requirements: {
      ...policy.external_ruleset_requirements,
      allow_force_push: true,
    },
  };
  assert.ok(
    issueCodes(
      validateRequiredContexts(unsafeRuleset, noPullRequest, repositoryContext),
    ).includes("EXTERNAL_RULESET_REQUIREMENTS_UNSAFE"),
  );

  const unpinnedNode = new Map(workflows);
  unpinnedNode.set(
    ".github/workflows/governance.yml",
    "on:\n  pull_request:\njobs:\n  governance:\n    name: governance · traceability · release\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, unpinnedNode, repositoryContext),
    ).includes("WORKFLOW_NODE_RUNTIME_UNPINNED"),
  );

  const ownershipDeleted = codeowners.replace(
    "/scripts/governance-*.mjs @mlhjyx",
    "",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, workflows, {
        codeowners: ownershipDeleted,
      }),
    ).includes("CODEOWNER_PROTECTION_MISSING"),
  );

  for (const scannerConfig of ["/.gitleaks.toml", "/.gitleaksignore"]) {
    const unprotectedScannerConfig = codeowners.replace(
      `${scannerConfig} @mlhjyx`,
      "",
    );
    assert.ok(
      issueCodes(
        validateRequiredContexts(policy, workflows, {
          codeowners: unprotectedScannerConfig,
        }),
      ).includes("CODEOWNER_PROTECTION_MISSING"),
      scannerConfig,
    );
  }

  const movingTag = new Map(workflows);
  movingTag.set(
    ".github/workflows/governance.yml",
    "on:\n  pull_request:\njobs:\n  governance:\n    name: governance · traceability · release\n    steps:\n      - uses: actions/setup-node@v7\n        with:\n          node-version: 22\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, movingTag, repositoryContext),
    ).includes("WORKFLOW_ACTION_UNPINNED"),
  );

  const unlistedWorkflow = new Map(workflows);
  unlistedWorkflow.set(
    ".github/workflows/unlisted.yml",
    "on:\n  pull_request:\njobs:\n  audit:\n    name: unlisted audit\n    steps:\n      - uses: actions/checkout@v7\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, unlistedWorkflow, repositoryContext),
    ).includes("WORKFLOW_ACTION_UNPINNED"),
  );

  const missingRevision = new Map(workflows);
  missingRevision.set(
    ".github/workflows/governance.yml",
    "on:\n  pull_request:\njobs:\n  governance:\n    name: governance · traceability · release\n    steps:\n      - uses: actions/setup-node\n        with:\n          node-version: 22\n",
  );
  assert.ok(
    issueCodes(
      validateRequiredContexts(policy, missingRevision, repositoryContext),
    ).includes("WORKFLOW_ACTION_UNPINNED"),
  );
});

test("pilot Release Bundle rejects expired evidence even when every approval says PASS", () => {
  const staleEvidence = releaseEvidence({
    valid_until: "2026-08-07T11:59:59.000Z",
  });
  const result = validateReleaseBundle(
    releaseBundle(),
    releaseValidationContext({
      evidence_by_id: new Map([[staleEvidence.evidence_id, staleEvidence]]),
    }),
  );
  assert.ok(issueCodes(result).includes("RELEASE_FRESH_EVIDENCE_REQUIRED"));
});

test("pilot evidence must bind the exact implementation commit and environment", () => {
  const wrongCommit = runtimeEvidence({ environment: "pilot" });
  const wrongCommitResult = validateReleaseBundle(
    releaseBundle(),
    releaseValidationContext({
      evidence_by_id: new Map([[wrongCommit.evidence_id, wrongCommit]]),
    }),
  );
  assert.ok(
    issueCodes(wrongCommitResult).includes(
      "RELEASE_EVIDENCE_IDENTITY_MISMATCH",
    ),
  );

  const wrongEnvironment = runtimeEvidence({ commit: SHA_D });
  const wrongEnvironmentResult = validateReleaseBundle(
    releaseBundle(),
    releaseValidationContext({
      evidence_by_id: new Map([
        [wrongEnvironment.evidence_id, wrongEnvironment],
      ]),
    }),
  );
  assert.ok(
    issueCodes(wrongEnvironmentResult).includes(
      "RELEASE_EVIDENCE_IDENTITY_MISMATCH",
    ),
  );
});

test("Release Bundle implementation and source identity must match merge evidence", () => {
  const mutant = releaseBundle({ implementation_commit: SHA_C });
  const validation = validateReleaseBundle(
    mutant,
    releaseValidationContext({
      evidence_by_id: new Map([
        [
          "runtime-api-development-20260807",
          releaseEvidence({ commit: SHA_C }),
        ],
      ]),
    }),
  );
  assert.ok(
    issueCodes(validation).includes("RELEASE_IMPLEMENTATION_MERGE_MISMATCH"),
  );
});
