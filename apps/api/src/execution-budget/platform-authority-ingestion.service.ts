import { Injectable } from '@nestjs/common';
import { ExecutionBudgetAuthorityRepository } from './execution-budget-authority.repository';
import { ExecutionBudgetGrantVerifier } from './execution-budget-grant.verifier';

@Injectable()
export class PlatformExecutionBudgetAuthorityIngestionService {
  constructor(
    private readonly verifier: ExecutionBudgetGrantVerifier,
    private readonly repository: ExecutionBudgetAuthorityRepository,
  ) {}

  async ingest(
    compactJws: string,
  ): Promise<{ authorityId: string; replay: boolean }> {
    const verified = await this.verifier.verifyPlatform(compactJws);
    return this.repository.ingestPlatform(verified);
  }
}
