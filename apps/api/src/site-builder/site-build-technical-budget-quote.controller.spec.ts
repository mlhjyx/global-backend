import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { REQUIRED_SCOPES_METADATA } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { type IntakeDto } from './dto/intake.dto';
import { type CreateBuildDto } from './dto/build.dto';
import { SiteBuildTechnicalBudgetQuoteController } from './site-build-technical-budget-quote.controller';
import { type SiteBuildTechnicalBudgetQuoteService } from './site-build-technical-budget-quote';

const SITE_ID = 'c9db2194-82b8-4a53-b328-a19d0d3b216e';
const INTAKE: IntakeDto = {
  company: { nameZh: '阿尔法泵业', nameEn: 'Alpha Pumps' },
  industry: 'isic-2813',
  products: ['industrial pump'],
  targetMarkets: ['DE'],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: 'sales@example.test',
};

function harness() {
  const quoteIntake = vi.fn(() => ({ operation: 'intake' }));
  const quoteRefurbish = vi.fn(() => ({ operation: 'refurbish' }));
  const service = { quoteIntake, quoteRefurbish } as unknown as SiteBuildTechnicalBudgetQuoteService;
  return {
    controller: new SiteBuildTechnicalBudgetQuoteController(service),
    quoteIntake,
    quoteRefurbish,
  };
}

describe('SiteBuildTechnicalBudgetQuoteController', () => {
  it('uses the exact intake semantic hash and returns the standard envelope', () => {
    const { controller, quoteIntake } = harness();

    expect(controller.quoteIntake(INTAKE)).toEqual({
      data: { operation: 'intake' },
    });
    expect(quoteIntake).toHaveBeenCalledWith(
      '337e71a7859f753977ab2f59a0bc99647894e0210c653747659607cf9bc217ba',
    );
  });

  it('normalizes refurbish through the same request contract before hashing', () => {
    const { controller, quoteRefurbish } = harness();
    const request: CreateBuildDto = {
      scope: 'site',
      options: { locales: ['en', 'de-DE'] },
    };

    expect(controller.quoteRefurbish(SITE_ID, request)).toEqual({
      data: { operation: 'refurbish' },
    });
    expect(quoteRefurbish).toHaveBeenCalledWith(
      SITE_ID,
      '57c9fc873a9cf659f7e08fe8e46e7ac1b083538ce413f4dad56400f8405c0017',
    );
  });

  it('is authenticated and requires acquisition:write without a Budget Grant guard', () => {
    expect(
      Reflect.getMetadata(GUARDS_METADATA, SiteBuildTechnicalBudgetQuoteController),
    ).toEqual([AuthGuard, ScopesGuard]);
    expect(
      Reflect.getMetadata(
        REQUIRED_SCOPES_METADATA,
        SiteBuildTechnicalBudgetQuoteController,
      ),
    ).toEqual(['acquisition:write']);
  });
});
