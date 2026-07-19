import type { RequestContext } from "../auth/request-context";
import {
  assertPublishableClaimSnapshotCurrent,
  buildPublishableClaimSnapshot,
  type CurrentPublishableClaimState,
  type PublishableClaimCandidate,
  type PublishableClaimSnapshot,
} from "./publishable-claim-snapshot";

export interface PublishableClaimSnapshotRepository {
  findByBuildRun(
    workspaceId: string,
    buildRunId: string,
  ): Promise<PublishableClaimSnapshot | null>;
  getSiteCompanyProfileId(
    workspaceId: string,
    siteId: string,
  ): Promise<string | null>;
  listCandidates(
    workspaceId: string,
    siteId: string,
    companyProfileId: string,
    capturedAt: Date,
  ): Promise<PublishableClaimCandidate[]>;
  persist(
    snapshot: PublishableClaimSnapshot,
  ): Promise<PublishableClaimSnapshot>;
  listCurrentStates(
    workspaceId: string,
    siteId: string,
    snapshot: PublishableClaimSnapshot,
  ): Promise<CurrentPublishableClaimState[]>;
}

export class PublishableClaimSnapshotServiceError extends Error {
  constructor(
    readonly code: "COPY_SITE_COMPANY_LINK_REQUIRED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "PublishableClaimSnapshotServiceError";
  }
}

export class PublishableClaimSnapshotService {
  constructor(
    private readonly repository: PublishableClaimSnapshotRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async capture(
    context: RequestContext,
    input: { siteId: string; buildRunId: string },
  ): Promise<PublishableClaimSnapshot> {
    const existing = await this.repository.findByBuildRun(
      context.workspaceId,
      input.buildRunId,
    );
    if (existing) return existing;

    const companyProfileId = await this.repository.getSiteCompanyProfileId(
      context.workspaceId,
      input.siteId,
    );
    if (!companyProfileId) {
      throw new PublishableClaimSnapshotServiceError(
        "COPY_SITE_COMPANY_LINK_REQUIRED",
        `site ${input.siteId} must be linked to a CompanyProfile before copy generation`,
      );
    }

    const capturedAt = this.now();
    const candidates = await this.repository.listCandidates(
      context.workspaceId,
      input.siteId,
      companyProfileId,
      capturedAt,
    );
    const snapshot = buildPublishableClaimSnapshot({
      workspaceId: context.workspaceId,
      siteId: input.siteId,
      companyProfileId,
      buildRunId: input.buildRunId,
      capturedAt,
      candidates,
    });
    return this.repository.persist(snapshot);
  }

  async assertCurrent(
    context: RequestContext,
    snapshot: PublishableClaimSnapshot,
  ): Promise<void> {
    const current = await this.repository.listCurrentStates(
      context.workspaceId,
      snapshot.siteId,
      snapshot,
    );
    assertPublishableClaimSnapshotCurrent(snapshot, current, this.now());
  }
}
