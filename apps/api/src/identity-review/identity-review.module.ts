import { Module } from "@nestjs/common";
import { IdentityReviewController } from "./identity-review.controller";
import { IdentityReviewRepository } from "./identity-review.repository";
import { IdentityReviewService } from "./identity-review.service";

@Module({
  controllers: [IdentityReviewController],
  providers: [IdentityReviewRepository, IdentityReviewService],
  exports: [IdentityReviewRepository],
})
export class IdentityReviewModule {}
