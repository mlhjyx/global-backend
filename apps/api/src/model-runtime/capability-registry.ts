import type { CapabilityRequirements, ModelCapabilityProfile } from './types';
import { immutableClone } from './immutable';

export const RETIRED_MODEL_ALIASES = Object.freeze([
  'minimax-m3',
  'doubao-seed-2.0-pro',
  'doubao-seed-2.0-lite',
] as const);

export class CapabilityRegistry {
  private readonly profiles = new Map<string, ModelCapabilityProfile>();
  private readonly retiredAliases: ReadonlySet<string>;

  constructor(
    profiles: readonly ModelCapabilityProfile[] = [],
    options: { retiredAliases?: readonly string[] } = {},
  ) {
    this.retiredAliases = new Set([
      ...RETIRED_MODEL_ALIASES,
      ...(options.retiredAliases ?? []),
    ]);
    for (const profile of profiles) {
      if (this.profiles.has(profile.alias)) throw new Error(`capability profile already registered: ${profile.alias}`);
      this.profiles.set(profile.alias, immutableClone(profile));
    }
  }

  negotiate(alias: string, requirements: CapabilityRequirements): ModelCapabilityProfile {
    if (this.retiredAliases.has(alias)) throw new Error(`model alias is retired: ${alias}`);
    const profile = this.profiles.get(alias);
    if (!profile) throw new Error(`model capability profile not registered: ${alias}`);
    if (profile.probe.result !== 'passed') throw new Error(`model capability probe has not passed: ${alias}`);
    if (requirements.protocols && !requirements.protocols.includes(profile.protocol)) {
      throw new Error(`model protocol does not satisfy task contract: ${alias}`);
    }
    if (requirements.minimumContextWindow && profile.contextWindow < requirements.minimumContextWindow) {
      throw new Error(`model context window does not satisfy task contract: ${alias}`);
    }
    if (requirements.minimumOutputTokens && profile.maximumOutputTokens < requirements.minimumOutputTokens) {
      throw new Error(`model output limit does not satisfy task contract: ${alias}`);
    }
    if (requirements.structuredOutput && !profile.structuredOutput.supported) {
      throw new Error(`model structured output does not satisfy task contract: ${alias}`);
    }
    if (requirements.structuredOutputDialect
      && !profile.structuredOutput.dialects.includes(requirements.structuredOutputDialect)) {
      throw new Error(`model structured output dialect does not satisfy task contract: ${alias}`);
    }
    if (requirements.reasoning && !profile.reasoningLevels.includes(requirements.reasoning)) {
      throw new Error(`model reasoning level does not satisfy task contract: ${alias}`);
    }
    if (requirements.nativeCache && !profile.nativeCache?.proven) {
      throw new Error(`model native cache has not been proven: ${alias}`);
    }
    if (requirements.tools && !profile.tools) throw new Error(`model tools do not satisfy task contract: ${alias}`);
    if (requirements.vision && !profile.vision) throw new Error(`model vision does not satisfy task contract: ${alias}`);
    if (requirements.reportsUsage && !profile.reportsUsage) throw new Error(`model usage reporting is unavailable: ${alias}`);
    if (requirements.reportsModel && !profile.reportsModel) throw new Error(`reported model identity is unavailable: ${alias}`);
    if (requirements.reportsRequestId && !profile.reportsRequestId) throw new Error(`request id reporting is unavailable: ${alias}`);
    if (requirements.settlementRequired && profile.settlementObservation === 'none') {
      throw new Error(`model settlement observation is unavailable: ${alias}`);
    }
    return profile;
  }
}
