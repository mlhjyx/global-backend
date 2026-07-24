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
  environment: string;
  commit: string;
  observedAt: string;
  correlationId?: string;
  workflowId?: string;
  eventId?: string;
  migrationId?: string;
  outcome: "SUCCESS" | "FAILURE" | "UNKNOWN";
  durationMs?: number;
  evidenceHash: string;
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
