import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));

const {
  COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH,
  prepareCopyRealCapabilityManifestFromRepository,
  writeCopyRealCapabilityManifestCreateOnly,
} = await import("../src/site-builder/eval/copy-real-capability-manifest-prep");

const artifact = await prepareCopyRealCapabilityManifestFromRepository(
  repositoryRoot,
);
await writeCopyRealCapabilityManifestCreateOnly(repositoryRoot, artifact);

process.stdout.write(
  `${JSON.stringify({
    outputPath: COPY_REAL_CAPABILITY_MANIFEST_OUTPUT_PATH,
    fixedSourceCommit: artifact.fixedSourceCommit,
    preparationHeadCommit: artifact.preparationHeadCommit,
    sourceBundleDigest: artifact.sourceBundle.digest,
    artifactDigest: artifact.artifactDigest,
    dispatchAuthorization: artifact.dispatchAuthorization,
    observedModelWireCalls: artifact.observedModelWireCalls,
  })}\n`,
);
