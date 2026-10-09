import { isExecutionControlError } from '../execution-budget/execution-control-error';

/**
 * Stages of a discovery run that can stop it with an error the stage does not
 * absorb. The names match the run's stats keys where one exists.
 */
export type DiscoveryRunStage =
  | 'plan'
  | 'query'
  | 'canonicalize'
  | 'websiteProfile'
  | 'fit'
  | 'enrich'
  | 'signals'
  | 'watches'
  | 'patentEnqueue';

/** What a FAILED run records about the error that stopped it: no message, no details. */
export interface DiscoveryRunFailure {
  readonly stage: DiscoveryRunStage;
  /** The innermost failure's type, code or class name, or UNCLASSIFIED. */
  readonly errorType: string;
  /** True when the shared classifier treats the error as an execution-control stop. */
  readonly control: boolean;
}

const ERROR_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const UNCLASSIFIED = 'UNCLASSIFIED';
const MAX_CAUSE_DEPTH = 8;
const MAX_PROTOTYPE_DEPTH = 8;

/** A data property's value, own or inherited; accessors and traps yield undefined. */
function dataProperty(value: object, key: string, inherited: boolean): unknown {
  try {
    let current: object | null = value;
    for (let depth = 0; current && depth <= MAX_PROTOTYPE_DEPTH; depth += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
      if (!inherited) return undefined;
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    /* A hostile value is classified without its fields. */
  }
  return undefined;
}

function identifier(value: unknown): string | undefined {
  return typeof value === 'string' && ERROR_TYPE.test(value) ? value : undefined;
}

/**
 * Temporal hands the workflow an ActivityFailure whose cause is the
 * ApplicationFailure (or TimeoutFailure) that ended the last attempt. Its
 * message is redacted at the activity boundary and is never read here.
 */
function failureType(error: unknown): string {
  let type = UNCLASSIFIED;
  const visited = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (!current || typeof current !== 'object' || visited.has(current)) break;
    visited.add(current);
    type =
      identifier(dataProperty(current, 'type', false)) ??
      identifier(dataProperty(current, 'code', false)) ??
      identifier(dataProperty(current, 'name', true)) ??
      type;
    current = dataProperty(current, 'cause', false);
  }
  return type;
}

/** Content-free description of the error that stopped a discovery run in `stage`. */
export function describeDiscoveryRunFailure(
  stage: DiscoveryRunStage,
  error: unknown,
): DiscoveryRunFailure {
  return {
    stage,
    errorType: failureType(error),
    control: isExecutionControlError(error),
  };
}
