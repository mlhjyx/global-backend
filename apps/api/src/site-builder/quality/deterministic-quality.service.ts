import { Injectable } from "@nestjs/common";
import {
  collectBrowserQualityFacts,
  type BrowserQualityRunnerInput,
} from "./browser-quality-runner";
import {
  evaluateDeterministicQuality,
  composeUnavailableAestheticEvaluation,
  type DeterministicQualityResult,
  type CollectedQualityFacts,
} from "./deterministic-quality";
import { StorageQualityArtifactSink } from "./quality-artifact-sink";

export interface RunDeterministicQualityInput extends BrowserQualityRunnerInput {
  /** Producer-isolated staging prefix ending in quality/round-N. */
  artifactPrefix: string;
}

/**
 * P4 deterministic seam. It intentionally stops before aesthetic review,
 * repair selection, Release materialization, or active-pointer mutation.
 */
@Injectable()
export class DeterministicQualityService {
  constructor(private readonly artifacts: StorageQualityArtifactSink) {}

  async evaluate(
    input: RunDeterministicQualityInput,
  ): Promise<DeterministicQualityResult> {
    const { artifactPrefix, ...browserInput } = input;
    const identity = {
      candidateSpecDigest: input.candidateSpecDigest,
      designBriefDigest: input.designBriefDigest,
      round: input.round,
    };
    const existing = await this.artifacts.loadCheckpoint(
      artifactPrefix,
      identity,
      input.signal,
    );
    if (existing) {
      composeUnavailableAestheticEvaluation(
        {
          spec: input.spec,
          ...identity,
          pages: [],
          lighthouse: [],
        } satisfies CollectedQualityFacts,
        existing,
        "protocol_mismatch",
      );
      return existing;
    }
    const facts = await collectBrowserQualityFacts(browserInput);
    const result = await evaluateDeterministicQuality(
      facts,
      artifactPrefix,
      this.artifacts,
      input.signal,
    );
    const committed = await this.artifacts.commitCheckpoint(
      artifactPrefix,
      { ...identity, result },
      input.signal,
    );
    composeUnavailableAestheticEvaluation(
      facts,
      committed,
      "protocol_mismatch",
    );
    return committed;
  }
}
