import { createHash } from 'node:crypto';
import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  SITE_SPEC_IDENTIFIER_PATTERN_SOURCE,
  SITE_SPEC_STYLE_PRESETS,
  type SiteSpecStylePreset,
} from '@global/contracts';
import type { BuildScopeInput } from './refurbish-launcher';

const IDENTIFIER = new RegExp(`^${SITE_SPEC_IDENTIFIER_PATTERN_SOURCE}$`);
const OPTION_KEYS = new Set(['stylePreset', 'pages', 'locales']);
const MAX_PAGES = 32;
const MAX_LOCALES = 8;

export interface NormalizedBuildRequest extends BuildScopeInput {
  scope: 'site' | 'page' | 'section';
  targetId?: string;
  options?: {
    stylePreset?: SiteSpecStylePreset;
    pages?: string[];
    locales?: string[];
  };
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

function invalid(message: string): never {
  throw new BadRequestException(errorBody('VALIDATION_ERROR', message));
}

function unavailable(
  code: 'BUILD_SCOPE_UNAVAILABLE' | 'BUILD_OPTION_UNAVAILABLE',
  message: string,
): never {
  throw new UnprocessableEntityException(errorBody(code, message));
}

function identifiers(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAGES) {
    invalid(`${field} must contain 1–${MAX_PAGES} identifiers`);
  }
  if (
    !value.every((item) => typeof item === 'string' && IDENTIFIER.test(item))
  ) {
    invalid(`${field} contains an invalid SiteSpec identifier`);
  }
  if (new Set(value).size !== value.length)
    invalid(`${field} must not contain duplicates`);
  return [...value] as string[];
}

function locales(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LOCALES) {
    invalid(`locales must contain 1–${MAX_LOCALES} BCP-47 tags`);
  }
  if (!value.every((item) => typeof item === 'string'))
    invalid('locales must be strings');
  let canonical: string[];
  try {
    canonical = Intl.getCanonicalLocales(value as string[]);
  } catch {
    invalid('locales contains an invalid BCP-47 tag');
  }
  if (canonical.length !== value.length)
    invalid('locales must not contain canonical duplicates');
  return canonical;
}

export function normalizeBuildRequest(
  input: BuildScopeInput,
): NormalizedBuildRequest {
  if (!['site', 'page', 'section'].includes(input.scope))
    invalid('invalid build scope');
  const targetId = input.targetId?.trim();
  if (input.scope === 'site' && targetId)
    invalid('scope=site does not accept targetId');
  if (input.scope !== 'site' && (!targetId || !IDENTIFIER.test(targetId))) {
    invalid(`scope=${input.scope} requires a valid targetId`);
  }

  const raw = input.options;
  const options: NormalizedBuildRequest['options'] = {};
  if (raw !== undefined) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      invalid('options must be an object');
    if (Object.keys(raw).some((key) => !OPTION_KEYS.has(key))) {
      invalid('options contains an unknown field');
    }
    if (raw.stylePreset !== undefined) {
      if (
        !(SITE_SPEC_STYLE_PRESETS as readonly string[]).includes(
          raw.stylePreset,
        )
      ) {
        invalid('stylePreset is not implemented by the renderer');
      }
      options.stylePreset = raw.stylePreset as SiteSpecStylePreset;
    }
    if (raw.pages !== undefined)
      options.pages = identifiers(raw.pages, 'pages');
    if (raw.locales !== undefined) options.locales = locales(raw.locales);
  }

  if (options.pages && input.scope !== 'site') {
    unavailable(
      'BUILD_OPTION_UNAVAILABLE',
      'options.pages can only be used with scope=site',
    );
  }
  if (options.stylePreset && (input.scope !== 'site' || options.pages)) {
    unavailable(
      'BUILD_OPTION_UNAVAILABLE',
      'stylePreset changes the whole Site and cannot be combined with a partial build',
    );
  }
  if (
    options.locales &&
    (options.locales.length !== 1 || options.locales[0] !== 'en')
  ) {
    unavailable(
      'BUILD_OPTION_UNAVAILABLE',
      'only the en locale is implemented by the current assembler',
    );
  }

  const hasOptions = Object.keys(options).length > 0;
  return {
    scope: input.scope,
    ...(targetId ? { targetId } : {}),
    ...(hasOptions ? { options } : {}),
  };
}

export function buildRequestHash(
  siteId: string,
  input: NormalizedBuildRequest,
): string {
  return createHash('sha256')
    .update(JSON.stringify({ siteId, ...input }))
    .digest('hex');
}
