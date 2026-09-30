/**
 * Angular CLI: the dev-only connect in the browser entry, and the dev-server route that hands it
 * the pairing token. See `patch/angular.ts` for why the token takes that route and no other.
 */

import {
  ANGULAR_DEFAULT_ENTRY,
  ANGULAR_PROXY_PATH,
  ANGULAR_TOKEN_PATH,
  angularProxyFile,
  patchAngularJson,
  patchAngularMain,
} from '@/patch/angular.js';
import { PatchKind } from '@/patch/patch-kind.js';
import { ANGULAR_WORKSPACE_FILE } from '@/detect/detect.js';
import { StepTitle } from './connect-steps.js';
import { patchStep } from './plan-framework.js';
import { alreadyOrMovedPort, retargetPort } from './port-steps.js';
import { StepStatus, type PlanInput, type Step } from './plan-types.js';

const ANGULAR_SETUP_GATED_NOTE =
  'The install gate scaffolds an Angular app (Angular 21, no SSR) on every release and requires a ' +
  'session, and this wiring was proven by hand on Angular 22 with and without SSR; nothing yet ' +
  'drives an Angular app to a verdict on each change. DOM, network, console and state ' +
  'tools work here; component identity does not (that is the React adapter). If no session ' +
  'appears, please open an issue.';

const ENTRY_DETAIL =
  'connect from the browser entry, dev-only (`ngDevMode`), through a dynamic import the ' +
  'production build drops';
const PROXY_DETAIL =
  'the `ng serve`-only module that hands the page this machine’s pairing token, read from ' +
  '~/.reticle at request time — never written into the project';
const SERVE_DETAIL = `point the serve target's proxyConfig at ${ANGULAR_PROXY_PATH} (\`ng build\` never reads it)`;

/** The full recipe, for when the entry is not a file `init` can see. */
function entryManual(input: PlanInput, entryPath: string): string {
  const recipe = patchAngularMain('', input.options.port, input.options.projectId);
  const code = recipe.kind === PatchKind.APPLY ? recipe.code : '';
  return `Add this to your browser entry (${entryPath}):\n\n${code}`;
}

function proxyStep(input: PlanInput): Step {
  const existing = input.angularProxySource ?? null;
  if (null !== existing && existing.includes(ANGULAR_TOKEN_PATH)) {
    return {
      title: StepTitle.ANGULAR_TOKEN_PROXY,
      target: ANGULAR_PROXY_PATH,
      status: StepStatus.ALREADY,
      detail: 'already there',
    };
  }
  return {
    title: StepTitle.ANGULAR_TOKEN_PROXY,
    target: ANGULAR_PROXY_PATH,
    status: StepStatus.APPLY,
    detail: PROXY_DETAIL,
    write: { path: ANGULAR_PROXY_PATH, content: angularProxyFile(), expect: [ANGULAR_TOKEN_PATH] },
  };
}

function serveStep(input: PlanInput): Step {
  const workspace = input.angularWorkspace ?? null;
  const manual = `In ${ANGULAR_WORKSPACE_FILE}, set the serve target's "options.proxyConfig" to "${ANGULAR_PROXY_PATH}".`;
  if (null === workspace) {
    return {
      title: StepTitle.ANGULAR_SERVE_CONFIG,
      target: ANGULAR_WORKSPACE_FILE,
      status: StepStatus.MANUAL,
      detail: manual,
    };
  }
  return patchStep(
    StepTitle.ANGULAR_SERVE_CONFIG,
    workspace.path,
    patchAngularJson(workspace.source),
    SERVE_DETAIL,
    manual,
  );
}

function entryStep(input: PlanInput): Step {
  const entry = input.angularEntry ?? null;
  if (null === entry) {
    return {
      title: StepTitle.CONNECT_SNIPPET_ANGULAR,
      target: ANGULAR_DEFAULT_ENTRY,
      status: StepStatus.MANUAL,
      detail: entryManual(input, ANGULAR_DEFAULT_ENTRY),
    };
  }
  // "already wired" read the entry without reading the port baked into its connect, so a re-run
  // with a new `--port` left the page dialling the old daemon.
  const patch = patchAngularMain(entry.source, input.options.port, input.options.projectId);
  // An entry the previous version wired is rewritten in place (its guard), so a re-run that ALSO
  // moves the port has to move it in the rewritten code — the ALREADY path below never sees it.
  const moved =
    PatchKind.APPLY === patch.kind ? retargetPort(patch.code, input.options.port) : null;
  return alreadyOrMovedPort(
    patchStep(
      StepTitle.CONNECT_SNIPPET_ANGULAR,
      entry.path,
      null === moved ? patch : { kind: PatchKind.APPLY, code: moved.code },
      ENTRY_DETAIL,
      entryManual(input, entry.path),
    ),
    entry.source,
    input.options.port,
  );
}

export function angularSteps(input: PlanInput): Step[] {
  return [
    {
      title: StepTitle.ANGULAR_SETUP_GATED,
      target: ANGULAR_WORKSPACE_FILE,
      status: StepStatus.NOTICE,
      detail: ANGULAR_SETUP_GATED_NOTE,
    },
    entryStep(input),
    proxyStep(input),
    serveStep(input),
  ];
}
