import { z } from 'zod';
import { FlowErrorCode } from '@iris/protocol';
import { IrisTool } from './tool-names.js';
import { asString } from './tools-helpers.js';
import type { ToolDef, ToolDeps } from './tools.js';

/** Map a structured FlowErrorCode to a legible one-line message for the agent. */
function flowErrorMessage(code: FlowErrorCode): string {
  switch (code) {
    case FlowErrorCode.INVALID_NAME:
      return 'invalid flow name — use a single safe segment (letters/digits/-/_), no path separators';
    case FlowErrorCode.NOT_FOUND:
      return 'no such flow on disk — run iris_flow_list to see saved flows';
    case FlowErrorCode.PARSE_FAILED:
      return 'flow file is malformed — fix or regenerate it with iris_flow_save';
    case FlowErrorCode.NO_RECORDING:
      return 'no compiled recording by that name — record one (iris_record_start/stop) first';
  }
}

/**
 * M8 Stage A FLOWFMT: persist a compiled recording as a git-checked, anchor-resolved flow and
 * read flows back. iris_flow_save converts a CompiledProgram's steps to semantic anchors;
 * iris_flow_list/iris_flow_load read .iris/flows/. Disk failures are returned as { error, code }.
 */
export const FLOW_TOOLS: ToolDef[] = [
  {
    name: IrisTool.FLOW_SAVE,
    description:
      'Persist the last/active recording (by name) as a git-checked, anchor-resolved flow at .iris/flows/<name>.json. Each step is bound to a SEMANTIC anchor (testid/role/signal), never a volatile ref; steps without a resolvable testid are kept with degraded:true (a "add a data-testid here" marker) rather than dropped. Returns { name, stepCount, degraded, empty } or { error, code }.',
    inputSchema: { name: z.string() },
    handler: (deps: ToolDeps, args) => {
      const name = asString(args['name']) ?? '';
      const program = deps.recordings.getCompiled(name);
      if (program === undefined) {
        return Promise.resolve({
          error: flowErrorMessage(FlowErrorCode.NO_RECORDING),
          code: FlowErrorCode.NO_RECORDING,
        });
      }
      return deps.flows
        .save(program)
        .then((res) =>
          res.ok ? res.value : { error: flowErrorMessage(res.code), code: res.code },
        );
    },
  },
  {
    name: IrisTool.FLOW_LIST,
    description:
      'List saved flow names under .iris/flows (a fresh agent learns the demonstrated journeys without a browser).',
    inputSchema: {},
    handler: (deps: ToolDeps) => deps.flows.list().then((flows) => ({ flows })),
  },
  {
    name: IrisTool.FLOW_LOAD,
    description:
      'Read + validate a saved flow by name from .iris/flows/<name>.json. Returns the FlowFile (version, name, createdAt, anchored steps) or a structured { error, code }.',
    inputSchema: { name: z.string() },
    handler: (deps: ToolDeps, args) =>
      deps.flows
        .load(asString(args['name']) ?? '')
        .then((res) =>
          res.ok ? res.value : { error: flowErrorMessage(res.code), code: res.code },
        ),
  },
];
