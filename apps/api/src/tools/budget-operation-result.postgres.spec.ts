import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import { ExecutionBudgetAuthorityRepository } from "../execution-budget/execution-budget-authority.repository";
import type { VerifiedExecutionBudgetAuthority } from "../execution-budget/execution-budget-authority.types";
import {
  BudgetStoreUnavailableError,
  PostgresBudgetStore,
  type BudgetStore,
} from "./budget-store";
import {
  projectModelResultForReplay,
  restoreModelResultFromReplay,
} from "../durable-results/model-result-replay";
import type { BudgetOperationResultQuery } from "./budget-operation-result";
import { TypedProjectionRegistry } from "../durable-results/typed-projection.registry";
import { registerModelResultProjections } from "../durable-results/model-result-projections";

const ENABLED = process.env.MARKET_CANDIDATE_GENERATION_DATABASE_TEST === "1";
const OWNER = process.env.MARKET_CANDIDATE_GENERATION_TEST_DATABASE_URL,
  APP = process.env.MARKET_CANDIDATE_GENERATION_TEST_APP_DATABASE_URL;
if (ENABLED) {
  if (!OWNER || !APP || APP !== process.env.APP_DATABASE_URL)
    throw Error("B2_TEST_URLS_REQUIRED");
  const a = new URL(OWNER),
    b = new URL(APP);
  if (
    [a, b].some(
      (u) =>
        u.protocol !== "postgresql:" ||
        u.hostname !== "127.0.0.1" ||
        u.pathname !== "/global_test" ||
        u.search ||
        u.hash,
    ) ||
    a.host !== b.host ||
    b.username !== "app_user"
  )
    throw Error("B2_OWN_DISPOSABLE_TARGET_REQUIRED");
}
const suite = ENABLED ? describe : describe.skip,
  SCHEMA = "market-candidates-generation/v1" as const;
const raw = () => ({
  data: { outcome: "COMPLETED_EMPTY", candidates: [] },
  provider: "synthetic",
  model: "synthetic",
});
const facts = {
  usage: {
    currency: "USD" as const,
    unit: "microusd" as const,
    callCount: 1,
    chargedMicrousd: "10000",
    upperBoundMicrousd: "800000",
  },
  costBasis: "provider_reported" as const,
};

suite(
  "typed operation result recovery using actual readonly app_user privileges",
  () => {
    let owner: PrismaClient,
      app: PrismaService,
      repository: ExecutionBudgetAuthorityRepository,
      store: PostgresBudgetStore;
    beforeAll(async () => {
      owner = new PrismaClient({ datasourceUrl: OWNER });
      app = new PrismaService();
      const [p] = await app.$queryRaw<
        Array<{
          database: string;
          user: string;
          superuser: boolean;
          bypass: boolean;
        }>
      >`SELECT current_database()AS database,current_user AS user,rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`;
      expect(p).toEqual({
        database: "global_test",
        user: "app_user",
        superuser: false,
        bypass: false,
      });
      repository = new ExecutionBudgetAuthorityRepository(app);
      store = new PostgresBudgetStore(app);
    });
    afterAll(async () => {
      await app?.$disconnect();
      await owner?.$disconnect();
    });
    async function seeded() {
      const workspaceId = randomUUID(),
        now = Math.floor(Date.now() / 1000);
      await owner.workspace.create({
        data: { id: workspaceId, name: "Synthetic readonly-result fixture" },
      });
      const claim: VerifiedExecutionBudgetAuthority = {
        schemaVersion: "execution-budget-grant/v1",
        authorityKind: "WORKSPACE_GRANT",
        issuer: "https://synthetic-control.example.test",
        audience: "global-backend:execution-budget",
        jti: randomUUID(),
        purpose: "icp.design",
        workspaceId,
        subjectType: "company",
        subjectId: randomUUID(),
        requestSha256: "c".repeat(64),
        scheduleId: null,
        currency: "USD",
        unit: "microusd",
        capMicrousd: 800000n,
        capPerRunMicrousd: null,
        campaignCapMicrousd: null,
        maxRuns: null,
        tokenSha256: randomBytes(32).toString("hex"),
        issuedAt: now - 5,
        notBefore: now - 5,
        expiresAt: now + 240,
      };
      const accountKey = "synthetic:" + randomUUID(),
        binding = await repository.consumeWorkspaceAndOpen(claim, accountKey);
      const operationKey = randomBytes(32).toString("hex"),
        reservation = await store.reserve({
          workspaceId,
          accountKey,
          operationKey,
          estimatedMicrousd: 800000n,
        });
      return {
        workspaceId,
        accountKey,
        binding,
        reservation,
        query: {
          scopeKey: workspaceId,
          authorityId: binding.authorityId,
          accountKey,
          accountGeneration: binding.generation,
          operationKey,
          resultSchema: SCHEMA,
        } as BudgetOperationResultQuery,
      };
    }
    async function read(query: BudgetOperationResultQuery) {
      const capability = (store as BudgetStore).readOperationResult;
      if (!capability)
        throw new BudgetStoreUnavailableError(
          "readonly operation result capability unavailable",
        );
      return capability.call(store, query);
    }
    async function snapshot() {
      return owner.$queryRaw<
        Array<{
          authorities: number;
          accounts: number;
          operations: number;
          fingerprint: string;
        }>
      >`SELECT(SELECT count(*)::int FROM execution_budget_authority)AS authorities,(SELECT count(*)::int FROM tool_budget_account)AS accounts,(SELECT count(*)::int FROM tool_budget_operation)AS operations,(SELECT md5(coalesce(string_agg(to_jsonb(t)::text,''ORDER BY id),''))FROM tool_budget_operation t)AS fingerprint`;
    }
    it("reads original SETTLED output and receipt after close/expiry without reserve, attest or any ledger change", async () => {
      const f = await seeded(),
        projection = projectModelResultForReplay(SCHEMA, raw());
      const settled = await store.settle(
        f.reservation,
        10000n,
        projection,
        facts,
      );
      await store.close({
        workspaceId: f.workspaceId,
        accountKey: f.accountKey,
        force: true,
      });
      await owner.$executeRaw`UPDATE execution_budget_authority SET issued_at=issued_at-INTERVAL'1 hour',not_before=not_before-INTERVAL'1 hour',expires_at=expires_at-INTERVAL'1 hour' WHERE id=${f.binding.authorityId}::uuid`;
      const before = await snapshot(),
        value = await read(f.query);
      expect(value).toEqual({
        status: "SETTLED",
        projection,
        receipt: settled.receipt,
      });
      if (value.status !== "SETTLED") throw Error("expected fixture settled");
      expect(restoreModelResultFromReplay(SCHEMA, value.projection)).toEqual(
        raw(),
      );
      expect(await snapshot()).toEqual(before);
    });
    it.each(["RESERVED", "RELEASED", "RESULT_UNKNOWN"] as const)(
      "returns status %s with no result payload and no ledger mutation",
      async (status) => {
        const f = await seeded();
        if (status === "RELEASED") await store.release(f.reservation);
        if (status === "RESULT_UNKNOWN")
          await store.markResultUnknown(f.reservation);
        const before = await snapshot();
        expect(await read(f.query)).toEqual({ status });
        expect(await snapshot()).toEqual(before);
      },
    );
    it("does not expose another workspace and never uses a platform writer", async () => {
      const f = await seeded();
      await store.settle(
        f.reservation,
        10000n,
        projectModelResultForReplay(SCHEMA, raw()),
        facts,
      );
      const other = await seeded();
      expect(await read({ ...f.query, scopeKey: other.workspaceId })).toEqual({
        status: "NOT_FOUND",
      });
      await expect(
        read({ ...f.query, scopeKey: "platform" }),
      ).rejects.toThrow();
    });
    it("rejects wrong authority/generation/schema and corrupted settled digest/facts rather than dispatching to recover", async () => {
      const f = await seeded();
      await store.settle(
        f.reservation,
        10000n,
        projectModelResultForReplay(SCHEMA, raw()),
        facts,
      );
      await expect(
        read({ ...f.query, authorityId: randomUUID() }),
      ).rejects.toThrow();
      await expect(
        read({ ...f.query, accountGeneration: f.query.accountGeneration + 1 }),
      ).rejects.toThrow();
      await expect(
        read({ ...f.query, resultSchema: "taxonomy-code/v1" }),
      ).rejects.toThrow();
      await owner.$executeRaw`UPDATE tool_budget_operation SET result_digest=${"f".repeat(64)} WHERE id=${f.reservation.operationId}::uuid`;
      await expect(read(f.query)).rejects.toThrow();
    });
    it("preserves the existing denial of app_user direct ledger INSERT/UPDATE/DELETE", async () => {
      const f = await seeded();
      for (const sql of [
        "UPDATE tool_budget_operation SET status=status WHERE false",
        "DELETE FROM tool_budget_operation WHERE false",
        "UPDATE tool_budget_account SET generation=generation WHERE false",
      ])
        await expect(
          app.withWorkspace(f.workspaceId, (tx) => tx.$executeRawUnsafe(sql)),
        ).rejects.toThrow(/permission denied/iu);
    });
    it("keeps the real PostgreSQL128KiB typed-envelope byte boundary independent of stricter domain/raw limits", async () => {
      const registry = registerModelResultProjections(
        new TypedProjectionRegistry(),
      );
      const statement = {
        text: "x",
        knowledgeState: "INFERENCE",
        basisKeys: [],
        impact: "x",
      };
      const candidate = () => ({
        proposal: {
          supplyOrCapability: {
            offeringId: "33333333-3333-4333-8333-333333333333",
            description: "x",
          },
          buyerOrganizationCountry: null,
          projectCountry: null,
          application: statement,
          organizationRole: statement,
          fitExplanation: statement,
          entryConditions: [],
          support: [],
          counterEvidence: [],
          gaps: [],
          recommendation: { status: "CONDITIONAL", reason: "x" },
          nextVerification: Array(100).fill("a") as string[],
        },
      });
      const input = {
        data: {
          outcome: "CANDIDATES_PROPOSED",
          candidates: Array.from({ length: 100 }, candidate),
        },
        provider: "p",
        model: "m",
      };
      const bytes = async (value: unknown) => {
        const [row] = await app.$queryRaw<
          Array<{ bytes: number }>
        >`SELECT octet_length(${JSON.stringify(value)}::jsonb::text)::integer AS bytes`;
        return row.bytes;
      };
      const initial = registry.project(SCHEMA, input);
      let remaining = 128 * 1024 - (await bytes(initial));
      expect(remaining).toBeGreaterThan(0);
      for (const card of input.data.candidates) {
        for (
          let i = 0;
          i < card.proposal.nextVerification.length && remaining > 0;
          i++
        ) {
          const added = Math.min(1999, remaining);
          card.proposal.nextVerification[i] += "a".repeat(added);
          remaining -= added;
        }
      }
      expect(remaining).toBe(0);
      const at = registry.project(SCHEMA, input);
      expect(await bytes(at)).toBe(128 * 1024);
      await expect(
        registry.assertPostgresJsonbEnvelopeByteLimit(app, at),
      ).resolves.toBe(128 * 1024);
      const target = input.data.candidates
        .flatMap((c) =>
          c.proposal.nextVerification.map((value, index) => ({
            card: c,
            index,
            value,
          })),
        )
        .find((x) => x.value.length < 2000)!;
      target.card.proposal.nextVerification[target.index] += "a";
      const over = registry.project(SCHEMA, input);
      expect(await bytes(over)).toBe(128 * 1024 + 1);
      await expect(
        registry.assertPostgresJsonbEnvelopeByteLimit(app, over),
      ).rejects.toThrow("TYPED_PROJECTION_POSTGRES_TOO_LARGE");
    });
  },
);
