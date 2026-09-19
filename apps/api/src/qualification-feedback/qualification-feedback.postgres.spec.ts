import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { PrismaService } from "../prisma/prisma.service";
import type { RequestContext } from "../auth/request-context";
import {
  QualificationFeedbackService,
  QUALIFICATION_FEEDBACK_PRINCIPAL,
} from "./qualification-feedback.service";
import type { QualificationFeedbackEvent } from "./qualification-feedback.contract";

// Only the dedicated disposable harness may enable this suite. No database mocks.
describe.skipIf(process.env.QUALIFICATION_FEEDBACK_PG_TEST !== "1")(
  "qualification feedback / PostgreSQL16",
  () => {
    let owner: PrismaClient;
    let app: PrismaService;
    let service: QualificationFeedbackService;
    const workspaceId = randomUUID();
    const otherWorkspace = randomUUID();
    const leadId = randomUUID();
    const companyId = randomUUID();
    const ctx: RequestContext = {
      userId: QUALIFICATION_FEEDBACK_PRINCIPAL,
      workspaceId,
      roles: [],
      scopes: ["acquisition:label:write"],
    };
    const event = (): QualificationFeedbackEvent => ({
      schemaVersion: "qualification-feedback-reference/v1",
      eventType: "QUALIFICATION_DECISION_RECORDED",
      producer: "growthos-saas",
      eventId: randomUUID(),
      workspaceId,
      leadId,
      opportunityId: randomUUID(),
      decisionId: randomUUID(),
      revision: "1",
      decision: "REJECTED",
      occurredAt: "2026-09-19T12:00:00Z",
    });
    async function guard() {
      const marker = process.env.QUALIFICATION_FEEDBACK_PG_MARKER;
      if (!marker || !/^qfeedback_[a-f0-9]{20}$/.test(marker))
        throw new Error("Missing disposable verification marker");
      const rows = await owner.$queryRaw<
        Array<{ database: string; marker: string }>
      >`SELECT current_database() AS database, marker FROM disposable_verification_marker`;
      expect(rows).toEqual([{ database: marker, marker }]);
    }
    beforeAll(async () => {
      if (!process.env.QUALIFICATION_FEEDBACK_OWNER_URL)
        throw new Error("Missing disposable owner URL");
      owner = new PrismaClient({
        datasourceUrl: process.env.QUALIFICATION_FEEDBACK_OWNER_URL,
      });
      await guard();
      app = new PrismaService();
      expect(await app.reconnect()).toEqual({ status: "ready" });
      expect(
        await app.$queryRaw`SELECT current_database() AS database, marker FROM disposable_verification_marker`,
      ).toEqual([
        {
          database: process.env.QUALIFICATION_FEEDBACK_PG_MARKER,
          marker: process.env.QUALIFICATION_FEEDBACK_PG_MARKER,
        },
      ]);
      service = new QualificationFeedbackService(app);
      await owner.$executeRaw`INSERT INTO canonical_company(id,workspace_id,status) VALUES (${companyId}::uuid,${workspaceId}::uuid,'ENRICHED')`;
      await owner.$executeRaw`INSERT INTO lead(id,workspace_id,canonical_company_id,status,queue,version) VALUES (${leadId}::uuid,${workspaceId}::uuid,${companyId}::uuid,'QUALIFIED','ready',7)`;
    });
    afterAll(async () => {
      await app?.$disconnect();
      await owner?.$disconnect();
    });

    it("uses restricted app_user, FORCE RLS, and isolates receipts even without explicit query filters", async () => {
      const roles = await app.$queryRaw<
        Array<{
          name: string;
          privileged: boolean;
          inherit: boolean;
          memberships: bigint;
        }>
      >`SELECT current_user AS name, (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication) AS privileged, rolinherit AS inherit, (SELECT count(*) FROM pg_auth_members WHERE member=pg_roles.oid) AS memberships FROM pg_roles WHERE rolname=current_user`;
      expect(roles).toEqual([
        { name: "app_user", privileged: false, inherit: true, memberships: 0n },
      ]);
      const tables = await app.$queryRaw<
        Array<{
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }>
      >`SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relname IN ('canonical_company','lead','qualification_feedback_receipt') ORDER BY relname`;
      expect(tables).toHaveLength(3);
      expect(
        tables.every((row) => row.relrowsecurity && row.relforcerowsecurity),
      ).toBe(true);
      const input = event();
      await service.receive(ctx, input);
      expect(
        await app.withWorkspace(otherWorkspace, (tx) =>
          tx.qualificationFeedbackReceipt.findMany(),
        ),
      ).toEqual([]);
      expect(await app.qualificationFeedbackReceipt.findMany()).toEqual([]);
      expect(
        await service.receipt(
          { ...ctx, workspaceId: otherWorkspace },
          input.eventId,
        ),
      ).toMatchObject({ status: "NOT_RECEIVED" });
      const stored = await owner.qualificationFeedbackReceipt.findFirstOrThrow({
        where: { eventId: input.eventId },
      });
      await expect(
        app.withWorkspace(otherWorkspace, (tx) =>
          tx.qualificationFeedbackReceipt.create({
            data: {
              ...stored,
              id: randomUUID(),
              eventId: randomUUID(),
              decisionId: randomUUID(),
              opportunityId: randomUUID(),
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it("ten concurrent equal deliveries commit exactly one stable receipt and leave Lead unchanged", async () => {
      const input = event();
      const before =
        await owner.$queryRaw`SELECT * FROM lead WHERE id=${leadId}::uuid`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () => service.receive(ctx, input)),
      );
      expect(
        results.every(
          (result) => JSON.stringify(result) === JSON.stringify(results[0]),
        ),
      ).toBe(true);
      expect(await service.receive(ctx, input)).toEqual(results[0]);
      expect(await service.receipt(ctx, input.eventId)).toEqual(results[0]);
      expect(
        await owner.qualificationFeedbackReceipt.count({
          where: { eventId: input.eventId },
        }),
      ).toBe(1);
      expect(
        await owner.$queryRaw`SELECT * FROM lead WHERE id=${leadId}::uuid`,
      ).toEqual(before);
    });

    it("rejects changed payload, reused decision, and reused opportunity revision without adding receipts", async () => {
      const input = event();
      const receipt = await service.receive(ctx, input);
      for (const altered of [
        { ...input, decision: "CORRECTED" },
        { ...input, eventId: randomUUID() },
        { ...input, eventId: randomUUID(), decisionId: randomUUID() },
      ]) {
        await expect(service.receive(ctx, altered)).rejects.toMatchObject({
          status: 409,
        });
      }
      expect(await service.receipt(ctx, input.eventId)).toEqual(receipt);
      expect(
        await owner.qualificationFeedbackReceipt.count({
          where: { opportunityId: input.opportunityId },
        }),
      ).toBe(1);
    });

    it("rejects workspace mismatch and wrong principal without persistence", async () => {
      const input = event();
      await expect(
        service.receive(ctx, { ...input, workspaceId: otherWorkspace }),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        service.receive({ ...ctx, userId: "another-service" }, input),
      ).rejects.toMatchObject({ status: 403 });
      expect(
        await owner.qualificationFeedbackReceipt.count({
          where: { eventId: input.eventId },
        }),
      ).toBe(0);
    });

    it("rejects missing, foreign, and suppressed Leads", async () => {
      await guard();
      const foreign = randomUUID(),
        suppressed = randomUUID(),
        suppressedQueue = randomUUID();
      await owner.$executeRaw`INSERT INTO lead(id,workspace_id,canonical_company_id,status,queue) VALUES (${foreign}::uuid,${otherWorkspace}::uuid,${companyId}::uuid,'QUALIFIED','ready'),(${suppressed}::uuid,${workspaceId}::uuid,${companyId}::uuid,'SUPPRESSED','ready'),(${suppressedQueue}::uuid,${workspaceId}::uuid,${companyId}::uuid,'QUALIFIED','suppressed')`;
      for (const id of [randomUUID(), foreign, suppressed, suppressedQueue]) {
        const input = { ...event(), leadId: id };
        await expect(service.receive(ctx, input)).rejects.toMatchObject({
          status: 404,
        });
        expect(
          await owner.qualificationFeedbackReceipt.count({
            where: { eventId: input.eventId },
          }),
        ).toBe(0);
      }
    });

    it("forbids app updates and owner updates, and tenant Lead deletion cascades the receipt", async () => {
      await guard();
      const id = randomUUID();
      await owner.$executeRaw`INSERT INTO lead(id,workspace_id,canonical_company_id,status,queue) VALUES (${id}::uuid,${workspaceId}::uuid,${companyId}::uuid,'QUALIFIED','ready')`;
      const input = { ...event(), leadId: id };
      const receipt = await service.receive(ctx, input);
      await expect(
        app.withWorkspace(workspaceId, (tx) =>
          tx.qualificationFeedbackReceipt.update({
            where: { id: receipt.receiptId },
            data: { decision: "CORRECTED" },
          }),
        ),
      ).rejects.toThrow();
      await expect(
        owner.qualificationFeedbackReceipt.update({
          where: { id: receipt.receiptId },
          data: { decision: "CORRECTED" },
        }),
      ).rejects.toThrow();
      expect(await service.receipt(ctx, input.eventId)).toEqual(receipt);
      await app.withWorkspace(
        workspaceId,
        (tx) => tx.$executeRaw`DELETE FROM lead WHERE id=${id}::uuid`,
      );
      expect(
        await owner.qualificationFeedbackReceipt.count({
          where: { id: receipt.receiptId },
        }),
      ).toBe(0);
    });

    it("rejects an already frozen company even while its Lead is still qualified", async () => {
      await guard();
      const company = randomUUID(),
        lead = randomUUID();
      await owner.$executeRaw`INSERT INTO canonical_company(id,workspace_id,status) VALUES (${company}::uuid,${workspaceId}::uuid,'SUPPRESSED')`;
      await owner.$executeRaw`INSERT INTO lead(id,workspace_id,canonical_company_id,status,queue) VALUES (${lead}::uuid,${workspaceId}::uuid,${company}::uuid,'QUALIFIED','ready')`;
      const input = { ...event(), leadId: lead };
      await expect(service.receive(ctx, input)).rejects.toMatchObject({
        status: 404,
      });
      expect(
        await owner.qualificationFeedbackReceipt.count({
          where: { eventId: input.eventId },
        }),
      ).toBe(0);
    });

    it("waits for an in-flight company freeze and rejects after that freeze commits", async () => {
      await guard();
      const company = randomUUID(),
        lead = randomUUID();
      await owner.$executeRaw`INSERT INTO canonical_company(id,workspace_id,status) VALUES (${company}::uuid,${workspaceId}::uuid,'ENRICHED')`;
      await owner.$executeRaw`INSERT INTO lead(id,workspace_id,canonical_company_id,status,queue) VALUES (${lead}::uuid,${workspaceId}::uuid,${company}::uuid,'QUALIFIED','ready')`;
      let release!: () => void, locked!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const freeze = app.withWorkspace(workspaceId, async (tx) => {
        await tx.$executeRaw`UPDATE canonical_company SET status='SUPPRESSED' WHERE id=${company}::uuid`;
        locked();
        await gate;
      });
      await lockReady;
      const input = { ...event(), leadId: lead };
      let settled = false;
      const receive = service
        .receive(ctx, input)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        .finally(() => {
          settled = true;
        });
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !settled; attempt++) {
          const locks = await owner.$queryRaw<
            Array<{ blocked: boolean }>
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='app_user' AND wait_event_type='Lock' AND query LIKE '%canonical_company%') AS blocked`;
          if (locks[0]?.blocked) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        expect(settled).toBe(false);
      } finally {
        release();
        await freeze;
      }
      expect(await receive).toMatchObject({ error: { status: 404 } });
      expect(
        await owner.qualificationFeedbackReceipt.count({
          where: { eventId: input.eventId },
        }),
      ).toBe(0);
    });

    it("a later company freeze waits until the receiver commits its receipt", async () => {
      await guard();
      const company = randomUUID(),
        lead = randomUUID();
      await owner.$executeRaw`INSERT INTO canonical_company(id,workspace_id,status) VALUES (${company}::uuid,${workspaceId}::uuid,'ENRICHED')`;
      await owner.$executeRaw`INSERT INTO lead(id,workspace_id,canonical_company_id,status,queue) VALUES (${lead}::uuid,${workspaceId}::uuid,${company}::uuid,'QUALIFIED','ready')`;
      // Test-only insert barrier: service obtains its real company/Lead locks
      // before its INSERT reaches this advisory-lock trigger. No service mocks.
      await owner.$executeRawUnsafe(
        `CREATE FUNCTION disposable_pause_feedback_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(7192026); RETURN NEW; END $$`,
      );
      await owner.$executeRawUnsafe(
        `CREATE TRIGGER disposable_feedback_insert_barrier BEFORE INSERT ON qualification_feedback_receipt FOR EACH ROW EXECUTE FUNCTION disposable_pause_feedback_insert()`,
      );
      let release!: () => void, locked!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const lockReady = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const barrier = owner.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(7192026)::text`;
          locked();
          await gate;
        },
        { timeout: 10000 },
      );
      await lockReady;
      const input = { ...event(), leadId: lead };
      const receive = service.receive(ctx, input).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let freeze: Promise<unknown> | undefined;
      let freezeSettled = false;
      const waitForBlock = async (pattern: string) => {
        for (let attempt = 0; attempt < 150; attempt++) {
          const rows = await owner.$queryRaw<
            Array<{ blocked: boolean }>
          >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE usename='app_user' AND wait_event_type='Lock' AND query LIKE ${pattern}) AS blocked`;
          if (rows[0]?.blocked) return true;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        return false;
      };
      try {
        expect(
          await waitForBlock("%INSERT%qualification_feedback_receipt%"),
        ).toBe(true);
        freeze = app
          .withWorkspace(workspaceId, async (tx) => {
            await tx.$executeRaw`UPDATE canonical_company SET status='SUPPRESSED' WHERE id=${company}::uuid`;
          })
          .finally(() => {
            freezeSettled = true;
          });
        expect(await waitForBlock("%UPDATE canonical_company%")).toBe(true);
        expect(freezeSettled).toBe(false);
      } finally {
        release();
        await barrier;
        await receive;
        await freeze;
        await guard();
        await owner.$executeRawUnsafe(
          "DROP TRIGGER disposable_feedback_insert_barrier ON qualification_feedback_receipt",
        );
        await owner.$executeRawUnsafe(
          "DROP FUNCTION disposable_pause_feedback_insert()",
        );
      }
      const result = await receive;
      expect(result).toMatchObject({ value: { status: "RECORDED" } });
      expect(
        await owner.qualificationFeedbackReceipt.count({
          where: { eventId: input.eventId },
        }),
      ).toBe(1);
      expect(
        await owner.$queryRaw`SELECT status FROM canonical_company WHERE id=${company}::uuid`,
      ).toEqual([{ status: "SUPPRESSED" }]);
      // Exact replay remains an acknowledgement of the earlier durable receipt.
      expect(await service.receive(ctx, input)).toEqual(
        "value" in result ? result.value : undefined,
      );
    });

    it("does not acknowledge when a deferred database constraint fails at commit", async () => {
      await guard();
      await owner.$executeRawUnsafe(
        `CREATE FUNCTION disposable_fail_feedback_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'disposable deferred failure' USING ERRCODE='23514'; END $$`,
      );
      await owner.$executeRawUnsafe(
        `CREATE CONSTRAINT TRIGGER disposable_feedback_commit_failure AFTER INSERT ON qualification_feedback_receipt DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION disposable_fail_feedback_commit()`,
      );
      const input = event();
      try {
        await expect(service.receive(ctx, input)).rejects.toMatchObject({
          status: 503,
        });
        expect(
          await owner.qualificationFeedbackReceipt.count({
            where: { eventId: input.eventId },
          }),
        ).toBe(0);
        expect(await service.receipt(ctx, input.eventId)).toMatchObject({
          status: "NOT_RECEIVED",
        });
      } finally {
        await guard();
        await owner.$executeRawUnsafe(
          "DROP TRIGGER disposable_feedback_commit_failure ON qualification_feedback_receipt",
        );
        await owner.$executeRawUnsafe(
          "DROP FUNCTION disposable_fail_feedback_commit()",
        );
      }
    });
  },
);
