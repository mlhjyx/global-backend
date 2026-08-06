import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = realpathSync(resolve(import.meta.dirname, "../../.."));

const {
  COPY_QUALITY_MATRIX_MANIFEST_OUTPUT_PATH,
  prepareCopyQualityMatrixManifestFromRepository,
  writeCopyQualityMatrixManifestCreateOnly,
} = await import("../src/site-builder/eval/copy-quality-matrix-manifest-prep");

const artifact = prepareCopyQualityMatrixManifestFromRepository(repositoryRoot);
await writeCopyQualityMatrixManifestCreateOnly(repositoryRoot, artifact);

process.stdout.write(
  `${JSON.stringify({
    outputPath: COPY_QUALITY_MATRIX_MANIFEST_OUTPUT_PATH,
    fixedSourceCommit: artifact.fixedSourceCommit,
    sourceBundleDigest: artifact.sourceBundle.digest,
    planDigest: artifact.manifest.planDigest,
    admissionSourceDigest: artifact.admissionSourceDigest,
    artifactDigest: artifact.artifactDigest,
    dispatchAuthorization: artifact.dispatchAuthorization,
    observedNetworkCalls: artifact.observedNetworkCalls,
    observedModelWireCalls: artifact.observedModelWireCalls,
  })}\n`,
);
