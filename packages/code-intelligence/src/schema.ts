export const GRAPH_SCHEMA_VERSION = "contract-graph/v1" as const;

export type GraphNodeKind =
  | "capability"
  | "scenario"
  | "page"
  | "business_object"
  | "owner"
  | "decision"
  | "code_symbol"
  | "source_file"
  | "api"
  | "event"
  | "workflow"
  | "activity"
  | "data_model"
  | "migration"
  | "service"
  | "test"
  | "evidence"
  | "external_system"
  | "package"
  | "ci_job"
  | "deployment"
  | "dynamic_mechanism";

export type GraphEdgeKind =
  | "calls"
  | "publishes"
  | "consumes"
  | "reads"
  | "writes"
  | "generates"
  | "validates"
  | "owns"
  | "deploys"
  | "rolls_back"
  | "contains"
  | "implements"
  | "references"
  | "registers"
  | "depends_on"
  | "routes_to"
  | "modifies";

export interface SourceLocationV1 {
  path: string;
  line?: number;
  column?: number;
}

export interface GraphNodeV1 {
  id: string;
  kind: GraphNodeKind;
  label: string;
  attributes: Record<string, boolean | number | string | string[] | null>;
  locations: SourceLocationV1[];
}

export interface GraphEdgeV1 {
  id: string;
  kind: GraphEdgeKind;
  from: string;
  to: string;
  attributes: Record<string, boolean | number | string | string[] | null>;
  locations: SourceLocationV1[];
}

export interface EvidenceRefV1 {
  schemaVersion: "evidence-ref/v1";
  repositoryRoot: string;
  worktreePath: string;
  branch: string;
  commit: string;
  commitTime: string;
  dirty: boolean;
  sourceHash: string;
}

export type GraphDiagnosticCode =
  | "UNCLAIMED_DYNAMIC_MECHANISM"
  | "DYNAMIC_MECHANISM_EXCEPTION_EXPIRED"
  | "DYNAMIC_MECHANISM_OWNER_UNASSIGNED"
  | "DYNAMIC_MECHANISM_EXTRACTOR_MISSING"
  | "DYNAMIC_MECHANISM_UNOBSERVED"
  | "BROKEN_EDGE"
  | "DUPLICATE_NODE_CONFLICT"
  | "WORKTREE_DIRTY"
  | "STALE_GRAPH"
  | "WRONG_WORKTREE"
  | "EXTERNAL_OWNED"
  | "UNKNOWN_RELATION";

export interface GraphDiagnosticV1 {
  code: GraphDiagnosticCode;
  severity: "info" | "warning" | "error";
  message: string;
  nodeId?: string;
  location?: SourceLocationV1;
  attributes?: Record<string, boolean | number | string | string[] | null>;
}

export interface ContractGraphV1 {
  schemaVersion: typeof GRAPH_SCHEMA_VERSION;
  evidence: EvidenceRefV1;
  nodes: GraphNodeV1[];
  edges: GraphEdgeV1[];
  diagnostics: GraphDiagnosticV1[];
}

export interface CoverageItemV1 {
  mechanismId: string;
  category: string;
  status: "EXTRACTOR" | "DETERMINISTIC_TEST" | "TEMPORARY_EXCEPTION";
  accountableRole: string;
  assignee: "UNASSIGNED" | string;
  matchedLocations: number;
  extractor: string | null;
  expiresAt: string | null;
}

export interface CoverageReportV1 {
  schemaVersion: "contract-graph-coverage/v1";
  evidence: EvidenceRefV1;
  totals: {
    nodes: number;
    edges: number;
    files: number;
    errors: number;
    warnings: number;
  };
  mechanisms: CoverageItemV1[];
  unknownMechanisms: GraphDiagnosticV1[];
}

export interface RuntimeEvidenceV1 {
  schemaVersion: "runtime-evidence/v1";
  id: string;
  kind:
    | "API_HEALTH"
    | "SYSTEMD_SERVICE"
    | "COMPOSE_SERVICE"
    | "TEMPORAL_CLUSTER"
    | "TEMPORAL_SCHEDULE"
    | "OUTBOX_EVENT"
    | "DATABASE_MIGRATION"
    | "BUILD_RUN";
  environment: "development" | "preproduction";
  subject: string;
  /** Commit proven by the runtime itself; UNKNOWN must not be replaced by the collector commit. */
  commit: string;
  observedAt: string;
  sourceObservedAt?: string;
  graphNodeIds: string[];
  graphEdgeIds: string[];
  correlationId?: string;
  workflowId?: string;
  workflowRunId?: string;
  eventId?: string;
  eventType?: string;
  migrationId?: string;
  buildRunId?: string;
  scheduleId?: string;
  httpStatus?: number;
  outcome: "SUCCESS" | "FAILURE" | "UNKNOWN";
  durationMs?: number;
  metadata: Record<string, boolean | number | string | null>;
  evidenceHash: string;
}

export interface RuntimeEvidenceBundleV1 {
  schemaVersion: "runtime-evidence-bundle/v1";
  environment: "development" | "preproduction";
  capturedAt: string;
  collector: EvidenceRefV1;
  records: RuntimeEvidenceV1[];
}

export interface RuntimeEvidenceDiagnosticV1 {
  code:
    | "RUNTIME_EVIDENCE_TAMPERED"
    | "RUNTIME_EVIDENCE_STALE"
    | "RUNTIME_EVIDENCE_WRONG_WORKTREE"
    | "RUNTIME_COMMIT_UNPROVEN"
    | "RUNTIME_GRAPH_TARGET_MISSING"
    | "RUNTIME_PROBE_FAILED"
    | "STATIC_RELATION_UNOBSERVED";
  severity: "info" | "warning" | "error";
  message: string;
  evidenceId?: string;
  graphNodeId?: string;
  graphEdgeId?: string;
}

export interface RuntimeDifferenceReportV1 {
  schemaVersion: "runtime-difference-report/v1";
  evidence: EvidenceRefV1;
  environment: "development" | "preproduction";
  capturedAt: string;
  conclusion: "CONSISTENT" | "PARTIAL" | "CONTRADICTED";
  observedNodeIds: string[];
  observedEdgeIds: string[];
  staticOnlyNodeIds: string[];
  staticOnlyEdgeIds: string[];
  runtimeOnlyNodeIds: string[];
  runtimeOnlyEdgeIds: string[];
  failedEvidenceIds: string[];
  diagnostics: RuntimeEvidenceDiagnosticV1[];
}

export interface ImpactReportV1 {
  schemaVersion: "impact-report/v1";
  evidence: EvidenceRefV1;
  changedPaths: string[];
  businessImpact: Array<{
    capabilityId: string;
    scenarios: string[];
    userPaths: string[];
    confidence: "PROVEN" | "INFERRED" | "UNKNOWN";
  }>;
  codeImpact: string[];
  recommendedTests: string[];
  risks: string[];
  unknowns: string[];
  rollback: string[];
}
