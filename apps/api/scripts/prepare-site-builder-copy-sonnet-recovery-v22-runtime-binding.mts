import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  COPY_SONNET_RECOVERY_V22_RUNTIME_BINDING_OUTPUT_PATH,
  prepareCopySonnetRecoveryV22RuntimeBindingFromRepository,
  writeCopySonnetRecoveryRuntimeBindingCreateOnly,
} from "../src/site-builder/eval/copy-sonnet-recovery-runtime-binding-prep";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));

const artifact =
  await prepareCopySonnetRecoveryV22RuntimeBindingFromRepository(
    repositoryRoot,
  );
await writeCopySonnetRecoveryRuntimeBindingCreateOnly(repositoryRoot, artifact);

process.stdout.write(
  `${JSON.stringify({
    outputPath: COPY_SONNET_RECOVERY_V22_RUNTIME_BINDING_OUTPUT_PATH,
    fixedSourceCommit: artifact.fixedSourceCommit,
    preparationHeadCommit: artifact.preparationHeadCommit,
    sourceBundleDigest: artifact.sourceBundle.digest,
    compiledRuntimeDigest:
      artifact.compiledRuntimeExpectation.artifactTreeDigest,
    artifactDigest: artifact.artifactDigest,
    dispatchAuthorization: artifact.dispatchAuthorization,
    dispatchCapable: artifact.dispatchCapable,
    observedModelWireCalls: artifact.observedModelWireCalls,
  })}\n`,
);
