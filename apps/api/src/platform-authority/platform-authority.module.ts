import { Module } from "@nestjs/common";

import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import { PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1 } from "./platform-execution-contract";
import { resolveCurrentPlatformExecutionProviderSnapshotV1 } from "./platform-execution-provider-snapshot";
import { PlatformExecutionTechnicalQuoteController } from "./platform-execution-technical-quote.controller";
import { PlatformExecutionTechnicalQuoteReaderService } from "./platform-execution-technical-quote-reader";
import { PlatformExecutionTechnicalQuoteService } from "./platform-execution-technical-quote";
import {
  PlatformTechnicalQuoteServiceAuthenticationGuard,
  PlatformTechnicalQuoteServiceAuthenticationVerifier,
  UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier,
} from "./platform-technical-quote-service-auth";

const PLATFORM_EXECUTION_TECHNICAL_QUOTE_READER = {
  provide: PlatformExecutionTechnicalQuoteReaderService,
  useFactory: () =>
    new PlatformExecutionTechnicalQuoteReaderService({
      quoteService: new PlatformExecutionTechnicalQuoteService({
        policyAsset: loadVerifiedPlatformAuthorityPolicyAsset(),
        technicalContract: PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1,
      }),
      now: () => new Date(),
      providerSnapshot: resolveCurrentPlatformExecutionProviderSnapshotV1,
    }),
} as const;

@Module({
  controllers: [PlatformExecutionTechnicalQuoteController],
  providers: [
    {
      provide: PlatformTechnicalQuoteServiceAuthenticationVerifier,
      useClass: UnavailablePlatformTechnicalQuoteServiceAuthenticationVerifier,
    },
    PlatformTechnicalQuoteServiceAuthenticationGuard,
    PLATFORM_EXECUTION_TECHNICAL_QUOTE_READER,
  ],
})
export class PlatformAuthorityModule {}
