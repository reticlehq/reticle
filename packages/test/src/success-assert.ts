/**
 * FLOW2SPEC — the flow success-assertion oracle now lives in @syrin/iris-server so the live MCP
 * `iris_flow_replay` tool and this spec runner share ONE implementation (no divergent oracle).
 * Re-exported here to keep the spec-runner's import surface stable.
 */
export { successToPredicate, assertSuccess } from '@syrin/iris-server';
