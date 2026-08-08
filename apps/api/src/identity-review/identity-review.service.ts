import { BadRequestException, Injectable } from "@nestjs/common";
import type { RequestContext } from "../auth/request-context";
import { normalizeHumanIdentityReviewRequest } from "./identity-review.domain";
import { IdentityReviewRepository } from "./identity-review.repository";

@Injectable()
export class IdentityReviewService {
  constructor(private readonly repository: IdentityReviewRepository) {}

  async create(ctx: RequestContext, input: unknown) {
    let request;
    try {
      request = normalizeHumanIdentityReviewRequest(input);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException({
        error: {
          code: "IDENTITY_REVIEW_INVALID",
          message: "identity review request is invalid",
        },
      });
    }
    return this.repository.appendHuman(ctx, request, new Date());
  }

  list(
    ctx: RequestContext,
    canonicalCompanyId: string,
    page: { cursor: string | null; limit: number },
  ) {
    return this.repository.listByCompany(ctx, canonicalCompanyId, page);
  }
}
