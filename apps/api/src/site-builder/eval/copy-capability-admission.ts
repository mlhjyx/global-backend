import {
  validateCopyRealCapabilityAdmissionEnvelope,
  type CopyPilotCredentialAttestation,
  type CopyRealCapabilityAdmissionInput,
} from "./copy-real-capability-admission";
import {
  validateCopySonnetRecoveryAdmissionEnvelope,
  type CopySonnetRecoveryAdmissionInput,
  type CopySonnetRecoveryCredentialAttestation,
} from "./copy-sonnet-recovery-admission";

export type CopyCapabilityAdmissionInput =
  | CopyRealCapabilityAdmissionInput
  | CopySonnetRecoveryAdmissionInput;

export type CopyCapabilityCredentialAttestation =
  | CopyPilotCredentialAttestation
  | CopySonnetRecoveryCredentialAttestation;

export function isCopySonnetRecoveryAdmission(
  input: CopyCapabilityAdmissionInput,
): input is CopySonnetRecoveryAdmissionInput {
  return (
    input.manifest.schemaVersion ===
    "site-builder-copy-sonnet-recovery-runtime-manifest/2026-08-08-v1"
  );
}

export function validateCopyCapabilityAdmissionEnvelope(
  input: CopyCapabilityAdmissionInput,
  now: Date = new Date(),
): void {
  if (isCopySonnetRecoveryAdmission(input)) {
    validateCopySonnetRecoveryAdmissionEnvelope(input, now);
    return;
  }
  validateCopyRealCapabilityAdmissionEnvelope(input, now);
}
