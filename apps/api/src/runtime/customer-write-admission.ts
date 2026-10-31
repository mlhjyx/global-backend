import type {
  ComponentStatus,
  RuntimeReadinessReport,
} from "../health/runtime-readiness.service";

type HardComponent = keyof RuntimeReadinessReport["components"];
type ComponentFailure = Readonly<{ component: string; code: string }>;

/**
 * For each hard readiness component, the one failure code customer writes
 * tolerate; `null` means the component must be ok. `satisfies` keeps the API
 * from compiling until a newly added component is classified here.
 */
export const CUSTOMER_WRITE_TOLERATED_FAILURE = Object.freeze({
  database: null,
  migration: null,
  temporal_control_plane: null,
  worker: null,
  // The platform worker serves only the platform-automation namespace, which
  // no customer write uses. Tolerated only while it has no READY lease (none
  // fresh, or a same-release one still STARTING or DRAINING); a mixed release,
  // Temporal identity mismatch or lease query failure carries another code
  // and still closes customer writes.
  platform_worker: "PLATFORM_WORKER_NOT_READY",
  outbox_relay: null,
  api_runtime: null,
  storage: null,
  generic_artifact_storage: null,
  redis: null,
  model_gateway: null,
  renderer: null,
  browser: null,
  budget_grant_verification: null,
  auth_jwks: null,
  admission: null,
} as const satisfies Readonly<Record<HardComponent, string | null>>);

export type CustomerWriteAdmission = Readonly<{
  open: boolean;
  blocking: readonly ComponentFailure[];
}>;

const SNAPSHOT_INVALID = "RUNTIME_READINESS_SNAPSHOT_INVALID";
const COMPONENT_MISSING = "RUNTIME_READINESS_COMPONENT_MISSING";
const COMPONENT_INVALID = "RUNTIME_READINESS_COMPONENT_INVALID";
const OPEN: CustomerWriteAdmission = Object.freeze({
  open: true,
  blocking: Object.freeze([]),
});

function closed(blocking: readonly ComponentFailure[]): CustomerWriteAdmission {
  return Object.freeze({ open: false, blocking: Object.freeze([...blocking]) });
}

function isToleratedFailure(
  name: string,
  component: Partial<ComponentStatus> | null | undefined,
): boolean {
  const tolerated: string | null = Object.hasOwn(
    CUSTOMER_WRITE_TOLERATED_FAILURE,
    name,
  )
    ? CUSTOMER_WRITE_TOLERATED_FAILURE[name as HardComponent]
    : null;
  // `null` marks "must be ok"; it must never match a failure without a code.
  return (
    component?.status === "failed" &&
    tolerated !== null &&
    component.code === tolerated
  );
}

/**
 * Customer write admission (D3): judged against the customer dependency set,
 * not aggregate readiness. Every hard component must be ok, except a platform
 * worker failed with exactly PLATFORM_WORKER_NOT_READY. `/health/ready` keeps
 * reporting that case as 503. An aggregate-ready snapshot is admitted; an
 * unclassified, missing, malformed or inconsistent component stays closed.
 */
export function customerWriteAdmission(
  report: Pick<RuntimeReadinessReport, "status" | "components"> | undefined,
): CustomerWriteAdmission {
  if (report?.status === "ready") return OPEN;
  const components: unknown = report?.components;
  if (
    report?.status !== "not_ready" ||
    typeof components !== "object" ||
    components === null
  ) {
    return closed([{ component: "snapshot", code: SNAPSHOT_INVALID }]);
  }
  // Presence and failures come from the same enumeration, so a component the
  // enumeration skips counts as missing instead of silently passing.
  const entries = Object.entries(
    components as Readonly<
      Record<string, Partial<ComponentStatus> | null | undefined>
    >,
  );
  const present = new Set(entries.map(([name]) => name));
  const missing = Object.keys(CUSTOMER_WRITE_TOLERATED_FAILURE)
    .filter((name) => !present.has(name))
    .map((name) => ({ component: name, code: COMPONENT_MISSING }));
  const failures = entries.filter(
    ([, component]) => component?.status !== "ok",
  );
  const blocking = [
    ...missing,
    ...failures
      .filter(([name, component]) => !isToleratedFailure(name, component))
      .map(([name, component]) => ({
        component: name,
        code:
          typeof component?.code === "string"
            ? component.code
            : COMPONENT_INVALID,
      })),
  ];
  if (blocking.length > 0) return closed(blocking);
  // `not_ready` must name a failure; a snapshot naming none is inconsistent.
  return failures.length > 0
    ? OPEN
    : closed([{ component: "snapshot", code: SNAPSHOT_INVALID }]);
}
