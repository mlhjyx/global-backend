/**
 * A structured model operation may send the initial physical request and one
 * schema-repair request. Router reservation and all pre-execution budget
 * quotes must consume this single machine contract.
 */
export const MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND = 2 as const;
