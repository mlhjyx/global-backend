import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { buildM1ebGoldenFixtures } from "../design/m1eb-golden";
import { releaseSpecDigest } from "../release-artifact";
import { writeRendererOutputManifest } from "../renderer-build";
import {
  QualityCandidateService,
  type QualityCandidateIdentity,
} from "./quality-candidate.service";

const roots: string[] = [];
let golden: Awaited<ReturnType<typeof buildM1ebGoldenFixtures>>[number];

beforeAll(async () => {
  golden = (
    await buildM1ebGoldenFixtures(
      new URL("../../../../../", import.meta.url).pathname,
    )
  )[0]!;
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function renderedIdentity() {
  const root = await mkdtemp(path.join(tmpdir(), "quality-candidate-"));
  roots.push(root);
  await writeFile(path.join(root, "index.html"), "<h1>candidate</h1>");
  const basePath = "/preview/acme";
  const siteOrigin = "https://preview.example.test";
  const manifest = await writeRendererOutputManifest({
    root,
    candidateSpecDigest: releaseSpecDigest(golden.spec),
    basePath,
    siteOrigin,
  });
  const identity: QualityCandidateIdentity = {
    workspaceId: "10000000-0000-4000-8000-000000000001",
    siteId: "20000000-0000-4000-8000-000000000001",
    siteVersionId: "30000000-0000-4000-8000-000000000001",
    buildRunId: "40000000-0000-4000-8000-000000000001",
    designBriefDigest: golden.designBrief.digest,
    specDigest: releaseSpecDigest(golden.spec),
    rendererOutputDigest: manifest.treeDigest,
    basePath,
    siteOrigin,
    root,
  };
  return identity;
}

function fakePrisma() {
  const state = {
    runStatus: "running",
    versionStatus: "building",
    spec: structuredClone(golden.spec),
    release: null as null | { id: string; status: string },
  };
  return {
    state,
    withWorkspace: vi.fn(
      async (
        _workspaceId: string,
        callback: (tx: unknown) => Promise<unknown>,
      ) =>
        callback({
          $executeRaw: vi.fn(async () => 1),
          siteBuildRun: {
            findUnique: vi.fn(async () => ({ status: state.runStatus })),
          },
          siteVersion: {
            findUnique: vi.fn(async () => ({
              workspaceId: "10000000-0000-4000-8000-000000000001",
              siteId: "20000000-0000-4000-8000-000000000001",
              buildRunId: "40000000-0000-4000-8000-000000000001",
              buildStatus: state.versionStatus,
              spec: state.spec,
              specVersion: "1.1.0",
            })),
            updateMany: vi.fn(async ({ data }) => {
              state.spec = structuredClone(data.spec);
              return { count: 1 };
            }),
          },
          siteRelease: {
            findUnique: vi.fn(async () => state.release),
          },
        }),
    ),
  };
}

describe("QualityCandidateService fencing", () => {
  it("binds a building SiteVersion to the live renderer manifest and tree", async () => {
    const identity = await renderedIdentity();
    const prisma = fakePrisma();
    const service = new QualityCandidateService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.assembleQualityCandidate({
        identity,
        designBrief: golden.designBrief,
      }),
    ).resolves.toEqual(golden.spec);

    await writeFile(path.join(identity.root, "index.html"), "<h1>drift</h1>");
    await expect(
      service.assembleQualityCandidate({
        identity,
        designBrief: golden.designBrief,
      }),
    ).rejects.toThrow("RENDERER_OUTPUT_TREE_MISMATCH");
  });

  it("re-fences after a long evaluation and rejects a changed persisted candidate", async () => {
    const identity = await renderedIdentity();
    const prisma = fakePrisma();
    const deterministic = {
      evaluate: vi.fn(async () => {
        prisma.state.spec = {
          ...prisma.state.spec,
          site: {
            ...prisma.state.spec.site,
            seoGlobal: { siteName: "concurrent repair" },
          },
        };
        return {
          artifactSet: {},
          hardFailures: [],
          findings: [],
        };
      }),
    };
    const service = new QualityCandidateService(
      prisma as never,
      deterministic as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.evaluateQualityCandidate({
        identity,
        designBrief: golden.designBrief,
        quality: {
          round: 0,
          artifactPrefix: "quality/round-0",
          validation: {} as never,
        },
      }),
    ).rejects.toThrow("QUALITY_CANDIDATE_FENCE_LOST");
    expect(deterministic.evaluate).toHaveBeenCalledTimes(1);
  });

  it("commits one closed repair by digest CAS and replays the same result after ACK loss", async () => {
    const identity = await renderedIdentity();
    const prisma = fakePrisma();
    const nextSpec = {
      ...structuredClone(golden.spec),
      site: {
        ...golden.spec.site,
        seoGlobal: { siteName: "closed repair result" },
      },
    };
    const optionId = "items:home:section:2";
    const repairs = {
      generateCatalog: vi.fn(() => ({
        catalog: { catalogDigest: "a".repeat(64) },
        candidates: new Map(),
      })),
      applySelection: vi.fn(() => ({
        optionId,
        spec: nextSpec,
        designBrief: golden.designBrief,
        change: {
          kind: "bounded_item_count",
          pageId: "home",
          sectionId: "section",
          itemCount: 2,
        },
      })),
    };
    const render = async () => {
      const preparedRoot = await mkdtemp(
        path.join(tmpdir(), "quality-repair-prepared-"),
      );
      roots.push(preparedRoot);
      await writeFile(path.join(preparedRoot, "index.html"), "<h1>next</h1>");
      const manifest = await writeRendererOutputManifest({
        root: preparedRoot,
        candidateSpecDigest: releaseSpecDigest(nextSpec),
        basePath: identity.basePath,
        siteOrigin: identity.siteOrigin,
      });
      return {
        root: preparedRoot,
        manifest,
        promote: async () => {
          await rm(identity.root, { recursive: true, force: true });
          await rename(preparedRoot, identity.root);
        },
        cleanup: async () => rm(preparedRoot, { recursive: true, force: true }),
      };
    };
    const service = new QualityCandidateService(
      prisma as never,
      {} as never,
      repairs as never,
      {} as never,
    );
    const repairInput = {
      identity,
      context: {
        spec: golden.spec,
        brief: golden.designBrief,
      } as never,
      evaluation: {} as never,
      artifactSet: { artifactSetDigest: "b".repeat(64) } as never,
      selection: { optionId },
      render,
    };

    const first = await service.applyQualityRepair(repairInput);
    expect(releaseSpecDigest(prisma.state.spec)).toBe(
      releaseSpecDigest(nextSpec),
    );
    expect(first.identity.specDigest).toBe(releaseSpecDigest(nextSpec));

    const replay = await service.applyQualityRepair(repairInput);
    expect(replay.identity).toEqual(first.identity);
    expect(repairs.applySelection).toHaveBeenCalledTimes(2);
  });

  it("re-fences the evaluated renderer tree before consuming a repair selection", async () => {
    const identity = await renderedIdentity();
    const prisma = fakePrisma();
    const repairs = {
      generateCatalog: vi.fn(),
    };
    const service = new QualityCandidateService(
      prisma as never,
      {} as never,
      repairs as never,
      {} as never,
    );
    await writeFile(path.join(identity.root, "index.html"), "<h1>stale</h1>");

    await expect(
      service.applyQualityRepair({
        identity,
        context: {
          spec: golden.spec,
          brief: golden.designBrief,
        } as never,
        evaluation: {} as never,
        artifactSet: { artifactSetDigest: "b".repeat(64) } as never,
        selection: { optionId: "items:home:section:2" },
        render: vi.fn(),
      }),
    ).rejects.toThrow("RENDERER_OUTPUT_TREE_MISMATCH");
    expect(repairs.generateCatalog).not.toHaveBeenCalled();
  });

  it("reaches ready-release idempotency after a materialization ACK loss", async () => {
    const identity = await renderedIdentity();
    const prisma = fakePrisma();
    prisma.state.versionStatus = "succeeded";
    prisma.state.release = { id: "release-1", status: "ready" };
    await rm(identity.root, { recursive: true, force: true });
    const releaseIdentity = {
      releaseId: "release-1",
      artifactPrefix: "sites/site/releases/release-1",
      producerToken: "producer-1",
      releaseCreatedAt: "2026-07-24T00:00:00.000Z",
    };
    const materialized = {
      releaseId: "release-1",
      artifactKey: "release:release-1",
      artifactPrefix: releaseIdentity.artifactPrefix,
      artifactDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      producerToken: releaseIdentity.producerToken,
    };
    const releases = {
      reserveMaterialization: vi.fn(async () => releaseIdentity),
      materialize: vi.fn(async () => materialized),
    };
    const prepareQuality = vi.fn(async () => ({ manifest: {} }));
    const service = new QualityCandidateService(
      prisma as never,
      {} as never,
      {} as never,
      releases as never,
    );

    await expect(
      service.materializeApprovedRelease({
        workspaceId: identity.workspaceId,
        siteId: identity.siteId,
        siteVersionId: identity.siteVersionId,
        buildRunId: identity.buildRunId,
        root: identity.root,
        spec: golden.spec,
        storedSpecVersion: "1.1.0",
        designBrief: golden.designBrief,
        candidate: identity,
        prepareQuality,
      }),
    ).resolves.toEqual(materialized);
    expect(releases.reserveMaterialization).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSpecDigest: identity.specDigest }),
    );
    expect(releases.materialize).toHaveBeenCalledTimes(1);
  });
});
