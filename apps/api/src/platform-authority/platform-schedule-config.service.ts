import { Logger } from "@nestjs/common";
import {
  PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
  type PlatformExecutionScheduleId,
} from "./platform-execution-contract";
import {
  resolvePlatformAuthorityMode,
  type PlatformAuthorityMode,
} from "./platform-authority-mode";

export const CANONICAL_PLATFORM_SCHEDULE_IDS: readonly PlatformExecutionScheduleId[] =
  Object.freeze(
    PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1.rows.map((row) => row.scheduleId),
  );

const CANONICAL_SCHEDULE_ID_SET = new Set<string>(
  CANONICAL_PLATFORM_SCHEDULE_IDS,
);

export function isCanonicalPlatformScheduleId(
  value: unknown,
): value is PlatformExecutionScheduleId {
  return typeof value === "string" && CANONICAL_SCHEDULE_ID_SET.has(value);
}

export interface PlatformScheduleConfigRow {
  readonly scheduleId: PlatformExecutionScheduleId;
  readonly enabled: boolean;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface PlatformScheduleConfigToggleAudit {
  readonly scheduleId: PlatformExecutionScheduleId;
  readonly previousEnabled: boolean;
  readonly enabled: boolean;
  readonly updatedBy: string;
  readonly reason: string | null;
  readonly updatedAt: string;
  readonly mode: PlatformAuthorityMode;
}

interface StoredPlatformScheduleConfigRecord {
  readonly scheduleId: string;
  readonly enabled: boolean;
  readonly updatedBy: string;
  readonly updatedAt: Date;
}

export interface PlatformScheduleConfigReaderDb {
  readonly platformScheduleConfig: {
    findMany(args: {
      orderBy: { scheduleId: "asc" };
    }): Promise<StoredPlatformScheduleConfigRecord[]>;
    findUnique(args: {
      where: { scheduleId: string };
    }): Promise<StoredPlatformScheduleConfigRecord | null>;
  };
}

export interface PlatformScheduleConfigWriterDb {
  readonly platformScheduleConfig: {
    upsert(args: {
      where: { scheduleId: string };
      create: {
        scheduleId: string;
        enabled: boolean;
        updatedBy: string;
        updatedAt: Date;
      };
      update: {
        enabled: boolean;
        updatedBy: string;
        updatedAt: Date;
      };
    }): Promise<StoredPlatformScheduleConfigRecord>;
  };
}

export class PlatformScheduleConfigError extends Error {
  constructor(
    readonly code:
      | "PLATFORM_SCHEDULE_ID_INVALID"
      | "PLATFORM_SCHEDULE_UPDATED_BY_INVALID"
      | "PLATFORM_SCHEDULE_REASON_INVALID"
      | "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE"
      | "PLATFORM_SCHEDULE_CONFIG_WRITER_UNAVAILABLE",
  ) {
    super(code);
    this.name = "PlatformScheduleConfigError";
  }
}

function normalizeUpdatedBy(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 128 ||
    /[\p{Cc}]/u.test(trimmed)
  ) {
    throw new PlatformScheduleConfigError(
      "PLATFORM_SCHEDULE_UPDATED_BY_INVALID",
    );
  }
  return trimmed;
}

function normalizeReason(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > 256 || /[\p{Cc}]/u.test(trimmed)) {
    throw new PlatformScheduleConfigError("PLATFORM_SCHEDULE_REASON_INVALID");
  }
  return trimmed;
}

function mapRecord(
  raw: StoredPlatformScheduleConfigRecord,
): PlatformScheduleConfigRow {
  if (!isCanonicalPlatformScheduleId(raw.scheduleId)) {
    throw new PlatformScheduleConfigError("PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE");
  }
  const updatedAt =
    raw.updatedAt instanceof Date ? raw.updatedAt : new Date(raw.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) {
    throw new PlatformScheduleConfigError("PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE");
  }
  return Object.freeze({
    scheduleId: raw.scheduleId,
    enabled: Boolean(raw.enabled),
    updatedBy: String(raw.updatedBy),
    updatedAt,
  });
}

export class PlatformScheduleConfigService {
  private readonly logger = new Logger("PlatformScheduleConfig");

  constructor(
    private readonly deps: {
      readonly reader: PlatformScheduleConfigReaderDb;
      readonly writer?: PlatformScheduleConfigWriterDb | null;
      readonly env?: NodeJS.ProcessEnv;
      readonly onAudit?: (entry: PlatformScheduleConfigToggleAudit) => void;
    },
  ) {}

  async listAll(): Promise<readonly PlatformScheduleConfigRow[]> {
    try {
      const rows = await this.deps.reader.platformScheduleConfig.findMany({
        orderBy: { scheduleId: "asc" },
      });
      return Object.freeze(rows.map(mapRecord));
    } catch (error) {
      if (error instanceof PlatformScheduleConfigError) throw error;
      throw new PlatformScheduleConfigError(
        "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
      );
    }
  }

  async getByScheduleId(
    scheduleId: string,
  ): Promise<PlatformScheduleConfigRow | null> {
    if (!isCanonicalPlatformScheduleId(scheduleId)) {
      throw new PlatformScheduleConfigError("PLATFORM_SCHEDULE_ID_INVALID");
    }
    try {
      const row = await this.deps.reader.platformScheduleConfig.findUnique({
        where: { scheduleId },
      });
      return row ? mapRecord(row) : null;
    } catch (error) {
      if (error instanceof PlatformScheduleConfigError) throw error;
      throw new PlatformScheduleConfigError(
        "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
      );
    }
  }

  /**
   * Fail-closed Kill Switch check: returns true ONLY when the canonical row
   * exists in PostgreSQL and `enabled === true`.
   */
  async isEnabled(scheduleId: string): Promise<boolean> {
    const row = await this.getByScheduleId(scheduleId);
    return row?.enabled === true;
  }

  /**
   * Verifies `platform_schedule_config` is readable and contains all 4 canonical
   * schedule rows. Throws `PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE` otherwise.
   */
  async assertHealthy(): Promise<readonly PlatformScheduleConfigRow[]> {
    const rows = await this.listAll();
    const present = new Set<string>(rows.map((row) => row.scheduleId));
    for (const scheduleId of CANONICAL_PLATFORM_SCHEDULE_IDS) {
      if (!present.has(scheduleId)) {
        throw new PlatformScheduleConfigError(
          "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
        );
      }
    }
    return rows;
  }

  async setEnabled(input: {
    readonly scheduleId: string;
    readonly enabled: boolean;
    readonly updatedBy: string;
    readonly reason?: string;
  }): Promise<{
    readonly config: PlatformScheduleConfigRow;
    readonly audit: PlatformScheduleConfigToggleAudit;
  }> {
    if (
      !isCanonicalPlatformScheduleId(input.scheduleId) ||
      typeof input.enabled !== "boolean"
    ) {
      throw new PlatformScheduleConfigError("PLATFORM_SCHEDULE_ID_INVALID");
    }
    const updatedBy = normalizeUpdatedBy(input.updatedBy);
    const reason = normalizeReason(input.reason);
    const writer = this.deps.writer;
    if (!writer) {
      throw new PlatformScheduleConfigError(
        "PLATFORM_SCHEDULE_CONFIG_WRITER_UNAVAILABLE",
      );
    }

    let previousEnabled: boolean;
    try {
      const existing = await this.getByScheduleId(input.scheduleId);
      previousEnabled = existing?.enabled === true;
    } catch (error) {
      if (error instanceof PlatformScheduleConfigError) throw error;
      throw new PlatformScheduleConfigError(
        "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
      );
    }

    try {
      const now = new Date();
      const updated = await writer.platformScheduleConfig.upsert({
        where: { scheduleId: input.scheduleId },
        create: {
          scheduleId: input.scheduleId,
          enabled: input.enabled,
          updatedBy,
          updatedAt: now,
        },
        update: {
          enabled: input.enabled,
          updatedBy,
          updatedAt: now,
        },
      });
      const config = mapRecord(updated);
      const mode = resolvePlatformAuthorityMode(this.deps.env);
      const audit: PlatformScheduleConfigToggleAudit = Object.freeze({
        scheduleId: config.scheduleId,
        previousEnabled,
        enabled: config.enabled,
        updatedBy: config.updatedBy,
        reason,
        updatedAt: config.updatedAt.toISOString(),
        mode,
      });
      this.logger.log(
        `[platform-schedule-config-audit] ${JSON.stringify(audit)}`,
      );
      this.deps.onAudit?.(audit);
      return Object.freeze({ config, audit });
    } catch (error) {
      if (error instanceof PlatformScheduleConfigError) throw error;
      throw new PlatformScheduleConfigError(
        "PLATFORM_SCHEDULE_CONFIG_UNAVAILABLE",
      );
    }
  }
}
