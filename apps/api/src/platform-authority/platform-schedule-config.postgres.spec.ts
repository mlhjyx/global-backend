import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  CANONICAL_PLATFORM_SCHEDULE_IDS,
  PlatformScheduleConfigService,
} from "./platform-schedule-config.service";
import {
  createInternalDbPlatformBudgetStore,
  inspectInternalDbPlatformAuthorityReadiness,
  InternalDbPlatformEgressFencePort,
  InternalDbPlatformScheduleAdmission,
  PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH,
} from "./internal-db-platform-authority";
import { PlatformEgressFence } from "./platform-egress-fence.v1";
import { snapshotPlatformEgressOperation } from "./platform-egress-operation";
import {
  parsePlatformExecutionBudgetBinding,
  PLATFORM_SCHEDULE_AUTHORITY_SCOPES,
  platformScheduleAccountKey,
} from "../temporal/platform-schedule-authority";

const WRITER_URL = process.env.TEST_M10_PR3_PG_WRITER_URL?.trim();
const APP_USER_URL = process.env.TEST_M10_PR3_PG_APP_USER_URL?.trim();
const ENABLED = Boolean(WRITER_URL && APP_USER_URL);

describe.skipIf(!ENABLED)(
  "M10-PR3 real PG16 integration: platform_schedule_config ACL, CHECK constraints, and internal_db Kill Switch",
  () => {
    it("enforces app_user SELECT-only, platform_writer RW (no DELETE/TRUNCATE), CHECK constraints, and live Kill Switch", async () => {
      const writerDb = new PrismaClient({ datasourceUrl: WRITER_URL });
      const appDb = new PrismaClient({ datasourceUrl: APP_USER_URL });
      try {
        await writerDb.$connect();
        await appDb.$connect();

        const service = new PlatformScheduleConfigService({
          reader: appDb,
          writer: writerDb,
          env: { PLATFORM_AUTHORITY_MODE: "internal_db" },
        });

        // 1. Seeded 4 canonical schedules start disabled (fail-closed)
        const seeded = await service.listAll();
        expect(seeded.map((row) => row.scheduleId)).toEqual(
          [...CANONICAL_PLATFORM_SCHEDULE_IDS].sort(),
        );
        for (const row of seeded) {
          expect(row.enabled).toBe(false);
        }

        // 2. Readiness in internal_db mode is healthy directly from PostgreSQL without R4
        const readiness = await inspectInternalDbPlatformAuthorityReadiness(service);
        expect(readiness.status).toBe("ready");

        // 3. app_user (NOSUPERUSER NOBYPASSRLS) is DENIED INSERT/UPDATE/DELETE/TRUNCATE (PG 42501)
        await expect(
          appDb.$executeRawUnsafe(
            `UPDATE public.platform_schedule_config SET enabled = true WHERE schedule_id = 'sanctions-refresh'`,
          ),
        ).rejects.toThrow(/42501|permission denied/i);

        await expect(
          appDb.$executeRawUnsafe(
            `INSERT INTO public.platform_schedule_config (schedule_id, enabled, updated_by) VALUES ('acq-sweep', true, 'app_user')`,
          ),
        ).rejects.toThrow(/42501|permission denied/i);

        await expect(
          appDb.$executeRawUnsafe(
            `DELETE FROM public.platform_schedule_config WHERE schedule_id = 'acq-sweep'`,
          ),
        ).rejects.toThrow(/42501|permission denied/i);

        await expect(
          appDb.$executeRawUnsafe(`TRUNCATE TABLE public.platform_schedule_config`),
        ).rejects.toThrow(/42501|permission denied/i);

        // 4. platform_writer is ALSO denied DELETE / TRUNCATE and rejected by CHECK constraints on bad values
        await expect(
          writerDb.$executeRawUnsafe(
            `DELETE FROM public.platform_schedule_config WHERE schedule_id = 'acq-sweep'`,
          ),
        ).rejects.toThrow(/42501|permission denied/i);

        await expect(
          writerDb.$executeRawUnsafe(`TRUNCATE TABLE public.platform_schedule_config`),
        ).rejects.toThrow(/42501|permission denied/i);

        await expect(
          writerDb.$executeRawUnsafe(
            `INSERT INTO public.platform_schedule_config (schedule_id, enabled, updated_by) VALUES ('rogue-schedule', true, 'writer')`,
          ),
        ).rejects.toThrow(/23514|platform_schedule_config_schedule_id_chk/i);

        await expect(
          writerDb.$executeRawUnsafe(
            `UPDATE public.platform_schedule_config SET updated_by = '   ' WHERE schedule_id = 'acq-sweep'`,
          ),
        ).rejects.toThrow(/23514|platform_schedule_config_updated_by_chk/i);

        // 5. End-to-end live DB Kill Switch across admission, egress fence, and budget attestation
        const admission = new InternalDbPlatformScheduleAdmission(service);
        const fence = new PlatformEgressFence(
          new InternalDbPlatformEgressFencePort(service),
        );
        const budgetStore = createInternalDbPlatformBudgetStore(service);
        const scope = PLATFORM_SCHEDULE_AUTHORITY_SCOPES["sanctions-refresh"];
        const workflowRunId = "99999999-9999-4999-8999-999999999999";
        const accountKey = platformScheduleAccountKey(scope, workflowRunId);
        const op = snapshotPlatformEgressOperation({
          operationKey: "pg16-sanctions-op",
          budgetOperationId: "88888888-8888-4888-8888-888888888888",
          budgetOperationKey: "b".repeat(64),
          reservedMicrousd: 0n,
          execution: {
            kind: "tool",
            toolId: "sanctions.download",
            toolVersion: "1.0.0",
          },
        });

        await expect(
          admission.admit({
            executionScope: scope,
            workflowId: "pg16-sanctions-wf",
            workflowRunId,
          }),
        ).rejects.toThrow(PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH);

        const enabledResult = await service.setEnabled({
          scheduleId: "sanctions-refresh",
          enabled: true,
          updatedBy: "pg16-verifier",
          reason: "enable for live test",
        });
        expect(enabledResult.config.enabled).toBe(true);
        expect(enabledResult.audit.previousEnabled).toBe(false);

        const admitted = await admission.admit({
          executionScope: scope,
          workflowId: "pg16-sanctions-wf",
          workflowRunId,
        });
        const binding = parsePlatformExecutionBudgetBinding({
          authorityId: admitted.authorityId,
          scopeKey: "platform",
          accountKey,
          ...scope,
          workflowRunId,
          admissionReplay: admitted.replay,
        });

        const wire = vi.fn(async () => "dispatched");
        await expect(
          fence.authorizeAndDispatchPlatformEgress(
            {
              authorityId: binding.authorityId,
              scheduleId: binding.scheduleId,
              workflowId: "pg16-sanctions-wf",
              workflowRunId,
              scheduleRequestSha256: binding.requestSha256,
              accountKey: binding.accountKey,
            },
            op,
            wire,
          ),
        ).resolves.toBe("dispatched");
        expect(wire).toHaveBeenCalledOnce();

        // Flip Kill Switch OFF in DB -> subsequent egress and attestation fail immediately
        await service.setEnabled({
          scheduleId: "sanctions-refresh",
          enabled: false,
          updatedBy: "pg16-verifier",
          reason: "restore paused default",
        });
        const deniedWire = vi.fn(async () => "must-not-run");
        await expect(
          fence.authorizeAndDispatchPlatformEgress(
            {
              authorityId: binding.authorityId,
              scheduleId: binding.scheduleId,
              workflowId: "pg16-sanctions-wf",
              workflowRunId,
              scheduleRequestSha256: binding.requestSha256,
              accountKey: binding.accountKey,
            },
            op,
            deniedWire,
          ),
        ).rejects.toThrow(PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH);
        expect(deniedWire).not.toHaveBeenCalled();

        await expect(
          budgetStore.attestAuthorized!({
            authorityId: binding.authorityId,
            scopeKey: binding.scopeKey,
            accountKey: binding.accountKey,
          }),
        ).rejects.toThrow(PLATFORM_SCHEDULE_DISABLED_BY_KILL_SWITCH);
      } finally {
        await writerDb.$disconnect();
        await appDb.$disconnect();
      }
    });
  },
);
