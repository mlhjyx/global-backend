import {
  ProviderIdentityError,
  ProviderOutputError,
  TaskOutputValidationError,
} from "../../model-gateway/providers/provider-output-error";
import type { BlindVisualUnavailableReason } from "./blind-visual-calibration";

/**
 * Maps gateway exceptions onto the calibration harness's frozen unavailable
 * vocabulary. The caller persists only this bounded reason plus explicit
 * provenance/usage fields; raw provider error text is never evidence.
 */
export function classifyBlindVisualGatewayFailure(
  error: unknown,
): BlindVisualUnavailableReason {
  if (error instanceof ProviderIdentityError) {
    return "model_identity_mismatch";
  }
  if (error instanceof TaskOutputValidationError) return "schema_invalid";
  if (error instanceof ProviderOutputError) {
    // OpenAI Responses currently surfaces a token-limited response to the
    // provider layer as FINISH_REASON_INVALID: incomplete. It is incomplete
    // output, not a schema-quality judgment, and must use the truncation gate.
    return /TRUNCATED|FINISH_REASON.*(?:length|max_tokens|incomplete)/i.test(
      error.message,
    )
      ? "truncated"
      : "schema_invalid";
  }
  if (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && /abort|timeout|deadline/i.test(error.message))
  ) {
    return "timeout";
  }
  return "invocation_failed";
}
