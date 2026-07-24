import { Injectable } from "@nestjs/common";
import {
  collectBrowserQualityFacts,
  type BrowserQualityRunnerInput,
} from "./browser-quality-runner";
import {
  evaluateDeterministicQuality,
  type DeterministicQualityResult,
} from "./deterministic-quality";
import { StorageQualityArtifactSink } from "./quality-artifact-sink";

export interface RunDeterministicQualityInput
  extends BrowserQualityRunnerInput {
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
    const facts = await collectBrowserQualityFacts(browserInput);
    return evaluateDeterministicQuality(
      facts,
      artifactPrefix,
      this.artifacts,
      input.signal,
    );
  }
}
