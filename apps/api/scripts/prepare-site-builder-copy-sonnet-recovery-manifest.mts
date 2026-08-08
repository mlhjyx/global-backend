import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));

const {
  COPY_SONNET_RECOVERY_MANIFEST_OUTPUT_PATH,
  prepareCopySonnetRecoveryManifestFromRepository,
  writeCopySonnetRecoveryManifestCreateOnly,
} = await import("../src/site-builder/eval/copy-sonnet-recovery-manifest-prep");

const artifact =
  await prepareCopySonnetRecoveryManifestFromRepository(repositoryRoot);
await writeCopySonnetRecoveryManifestCreateOnly(repositoryRoot, artifact);

process.stdout.write(
  `${JSON.stringify({
    outputPath: COPY_SONNET_RECOVERY_MANIFEST_OUTPUT_PATH,
    fixedSourceCommit: artifact.fixedSourceCommit,
    preparationHeadCommit: artifact.preparationHeadCommit,
    sourceBundleDigest: artifact.sourceBundle.digest,
    recoveryPlanDigest: artifact.manifest.recoveryPlanDigest,
    artifactDigest: artifact.artifactDigest,
    dispatchAuthorization: artifact.dispatchAuthorization,
    dispatchCapable: artifact.dispatchCapable,
    observedModelWireCalls: artifact.observedModelWireCalls,
  })}\n`,
);
