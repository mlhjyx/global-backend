import { ApplicationFailure } from '@temporalio/activity';
import type {
  LawfulBasis,
  LawfulBasisKind,
} from '../discovery/provider-contract';
import { LAWFUL_BASIS_KINDS } from '../discovery/compliance/email-verification-gate';

/**
 * Pre-cutover backlog contract.
 *
 * The legacy sweep is a platform Schedule, while its historical Tool/Model
 * contexts charge workspace-scoped account keys. There is currently no
 * approved signed binding that maps the platform authority to those workspace
 * subjects. An ambient account or deterministic key is not authorization.
 * Every stage therefore parks before the first owner/workspace query, model,
 * Tool call, domain write, attempted count, or watermark update.
 */
const BACKLOG_AUTHORITY_HOLD =
  'EXECUTION_BUDGET_PLATFORM_AUTHORITY_REQUIRED' as const;

function authorityHold(): never {
  throw ApplicationFailure.nonRetryable(
    BACKLOG_AUTHORITY_HOLD,
    BACKLOG_AUTHORITY_HOLD,
  );
}

/**
 * Parse the explicitly configured interim lawful basis used by the historical
 * email-guess implementation. This pure helper remains available to compliance
 * tests; the schedule itself is parked before reading provider configuration.
 */
export function parseConfiguredLawfulBasis(
  config: unknown,
): LawfulBasis | undefined {
  if (!config || typeof config !== 'object') return undefined;
  const raw = (config as Record<string, unknown>).lawfulBasis;
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (
    typeof record.basis !== 'string' ||
    !(LAWFUL_BASIS_KINDS as readonly string[]).includes(record.basis)
  ) {
    return undefined;
  }
  return {
    basis: record.basis as LawfulBasisKind,
    ...(typeof record.ref === 'string' ? { ref: record.ref } : {}),
    ...(typeof record.note === 'string' ? { note: record.note } : {}),
  };
}

export interface BacklogPage {
  workspaceId: string;
  budgetScopeId?: string;
  limit?: number;
  cursor?: string | null;
}

export interface FitBacklogResult {
  scanned: number;
  judged: number;
  verdicts: Record<string, number>;
  nextCursor: string | null;
}

export interface EnrichBacklogResult {
  scanned: number;
  attempted: number;
  matched: number;
  nextCursor: string | null;
}

export interface WatchBacklogResult {
  scanned: number;
  registered: number;
  nextCursor: string | null;
}

export interface ContactBacklogResult {
  scanned: number;
  attempted: number;
  contactsCreated: number;
  nextCursor: string | null;
}

export interface GuessEmailsBacklogResult {
  scanned: number;
  attempted: number;
  guessed: number;
  skipped?: boolean;
  reason?: string;
  nextCursor: string | null;
}

export interface BacklogActivityDependencies {
  readonly prisma: unknown;
  readonly providers: unknown;
  readonly gateway: unknown;
  readonly ownerDb: unknown;
  readonly broker?: unknown;
  readonly runtimeTelemetry?: unknown;
  readonly budgetStore?: unknown;
  readonly platformWriter?: unknown;
  readonly activityRunId?: () => string | undefined;
}

export function createBacklogActivities(_deps: BacklogActivityDependencies) {
  return {
    async listBacklogTargets(): Promise<{
      targets: Array<{ workspaceId: string; icpId: string }>;
    }> {
      return authorityHold();
    },

    async qualifyFitBacklog(
      _args: BacklogPage & { icpId: string },
    ): Promise<FitBacklogResult> {
      return authorityHold();
    },

    async enrichBacklog(_args: BacklogPage): Promise<EnrichBacklogResult> {
      return authorityHold();
    },

    async enrichSignalsBacklog(
      _args: BacklogPage,
    ): Promise<EnrichBacklogResult> {
      return authorityHold();
    },

    async registerWatchesBacklog(
      _args: BacklogPage,
    ): Promise<WatchBacklogResult> {
      return authorityHold();
    },

    async discoverContactsBacklog(
      _args: BacklogPage & { icpId: string },
    ): Promise<ContactBacklogResult> {
      return authorityHold();
    },

    async guessEmailsBacklog(
      _args: BacklogPage & { icpId: string },
    ): Promise<GuessEmailsBacklogResult> {
      return authorityHold();
    },
  };
}

export type BacklogActivities = ReturnType<typeof createBacklogActivities>;
