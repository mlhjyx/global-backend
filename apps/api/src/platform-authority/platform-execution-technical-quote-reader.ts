import { types } from "node:util";

import {
  PLATFORM_AUTHORITY_MAX_RAW_BODY_BYTES,
  PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_SCHEMA_V1,
  canonicalizePlatformAuthorityRequestBodyV1,
} from "@global/contracts/platform-authority";

import {
  PlatformExecutionContractError,
  type PlatformExecutionProviderSnapshotV1,
  type PlatformExecutionScheduleId,
} from "./platform-execution-contract";
import {
  PlatformExecutionTechnicalQuoteError,
  type PlatformExecutionTechnicalQuoteV1,
  type PlatformExecutionTechnicalQuoteService,
} from "./platform-execution-technical-quote";

const READER_INPUT_KEYS = ["contentType", "rawBody"] as const;

export interface PlatformExecutionTechnicalQuoteReaderInput {
  readonly contentType: string;
  readonly rawBody: Uint8Array;
}

export interface PlatformExecutionTechnicalQuoteReaderDependencies {
  readonly quoteService: PlatformExecutionTechnicalQuoteService;
  readonly now: () => Date;
  readonly providerSnapshot: (
    scheduleId: PlatformExecutionScheduleId,
  ) => PlatformExecutionProviderSnapshotV1;
}

function invalid(): never {
  throw new PlatformExecutionTechnicalQuoteError(
    "PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID",
  );
}

function unavailable(): never {
  throw new PlatformExecutionTechnicalQuoteError(
    "PLATFORM_EXECUTION_BUDGET_QUOTE_UNAVAILABLE",
  );
}

function inputSnapshot(
  value: unknown,
): Readonly<Record<(typeof READER_INPUT_KEYS)[number], unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some((key) => typeof key !== "string") ||
      Object.keys(descriptors).sort().join("\0") !==
        [...READER_INPUT_KEYS].sort().join("\0")
    ) {
      return invalid();
    }
    const result = Object.create(null) as Record<
      (typeof READER_INPUT_KEYS)[number],
      unknown
    >;
    for (const key of READER_INPUT_KEYS) {
      const descriptor = descriptors[key];
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return invalid();
      }
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch {
    return invalid();
  }
}

/** Pure adapter from a strict raw quote-read request to the deterministic quote. */
export class PlatformExecutionTechnicalQuoteReaderService {
  constructor(
    private readonly dependencies: PlatformExecutionTechnicalQuoteReaderDependencies,
  ) {}

  read(
    rawInput: PlatformExecutionTechnicalQuoteReaderInput,
  ): PlatformExecutionTechnicalQuoteV1 {
    const input = inputSnapshot(rawInput);
    let canonical: ReturnType<
      typeof canonicalizePlatformAuthorityRequestBodyV1
    >;
    try {
      canonical = canonicalizePlatformAuthorityRequestBodyV1({
        contentType: input.contentType as string,
        rawBody: input.rawBody as Uint8Array,
        schema: PLATFORM_EXECUTION_TECHNICAL_QUOTE_REQUEST_SCHEMA_V1,
      });
    } catch {
      return invalid();
    }
    const values = canonical.values;
    let now: Date;
    try {
      now = this.dependencies.now();
    } catch {
      return unavailable();
    }
    let providerSnapshot: PlatformExecutionProviderSnapshotV1;
    try {
      providerSnapshot = this.dependencies.providerSnapshot(
        values.schedule_id as PlatformExecutionScheduleId,
      );
    } catch (error) {
      if (error instanceof PlatformExecutionContractError) return invalid();
      return unavailable();
    }
    const quote = this.dependencies.quoteService.quote({
      purpose: values.purpose,
      scheduleId: values.schedule_id,
      workflowType: values.workflow_type,
      workflowId: values.workflow_id,
      workflowRunId: values.workflow_run_id,
      scheduleRequestSha256: values.schedule_request_sha256,
      now,
      providerSnapshot,
    });
    if (
      Buffer.byteLength(JSON.stringify({ data: quote }), "utf8") >
      PLATFORM_AUTHORITY_MAX_RAW_BODY_BYTES
    ) {
      return unavailable();
    }
    return quote;
  }
}
