/**
 * Steps that TELL the user something rather than change anything.
 *
 * `StepStatus.NOTICE` exists because reporting these as `manual` made "steps left to do" a
 * number that could never reach zero. They are one category by that test: a dev server in a
 * container, an MCP registration Windows will not take, a UI library no gate covers. Reticle is
 * not going to fix any of them and the user is better off knowing.
 *
 * They moved out together when `plan.ts` crossed the 1000-line cap on merging 2.14.0. The cap is
 * a cohesion backstop rather than a budget, so the answer is a split along a real seam and not a
 * larger number.
 */
import { CONTAINERISED_TITLE, containerisedDevServerNote } from '../diagnose/containerised-dev-server.js';
import { mcpWindowsNote } from '../register/mcp.js';
import { unverifiedUiLibraryNote, WEBGL_CANVAS_LIMIT_NOTE } from '../patch/snippets.js';
import { FRAMEWORK_ADAPTERS } from './framework-adapter.js';
import { NodePlatform } from '../detect/platform.js';
import { UiLibrary } from '../detect/detect.js';
// `Step` and `PlanInput` are TYPES, so importing them back from `plan.ts` is erased at build
// time and creates no cycle. `StepStatus` and `MCP_TARGET` are values, and both are read inside
// function bodies rather than at module scope, which is what keeps the pair safe to import in
// both directions. If a third value is ever needed here, move the vocabulary to its own module
// rather than widening this.
import { MCP_TARGET, StepStatus } from './plan.js';
import type { PlanInput, Step } from './plan.js';

const WINDOWS_MCP_TITLE = 'Windows MCP spawn';

/**
 * The two things a containerised dev server does differently, said before they go wrong.
 *
 * Null for every project with no container marker near it, which is almost all of them — so this
 * adds nothing to the ordinary plan and does not move the install baseline.
 */
export function containerisedStep(input: PlanInput): Step | null {
  const marker = input.containerMarker;
  if (marker === undefined || 0 === marker.length) return null;
  return {
    title: CONTAINERISED_TITLE,
    target: marker,
    status: StepStatus.NOTICE,
    detail: containerisedDevServerNote(marker),
  };
}

/** Windows only. The reported install never reached mcpManual because `claude mcp add` succeeded. */
export function windowsMcpNoteStep(input: PlanInput): Step | null {
  if (input.platform !== NodePlatform.WINDOWS) return null;
  return {
    title: WINDOWS_MCP_TITLE,
    target: MCP_TARGET,
    status: StepStatus.NOTICE,
    detail: mcpWindowsNote(),
  };
}

/**
 * A step that says out loud when the app isn't React. SvelteKit already carries its own unverified
 * note, so it isn't doubled up here.
 */
export function uiLibraryStep(input: PlanInput): Step[] {
  const lib = input.detection.uiLibrary;
  // A framework whose own recipe already says it is unverified must not be argued with by a second,
  // more generic notice. Asked of the registry rather than of a remembered `SVELTEKIT || NUXT` pair:
  // the pair was the answer, not the question, and a third framework joining it was a silent edit.
  if (lib === UiLibrary.REACT) return [];
  if (FRAMEWORK_ADAPTERS[input.detection.framework].carriesOwnUnverifiedNote) return [];
  if (lib === UiLibrary.UNKNOWN) return [];
  return [
    {
      title: `${lib} is UNVERIFIED`,
      target: 'package.json',
      status: StepStatus.NOTICE,
      detail: unverifiedUiLibraryNote(lib),
    },
  ];
}

/**
 * A WebGL subtree is pixels, and Reticle reads the DOM.
 *
 * react-three-fiber and its relatives render into a canvas, so the tools that find and drive
 * elements have nothing to find. Disclosed rather than blocked: the rest of the app is still
 * verifiable and a NOTICE says which part is not.
 */
export function webGlCanvasStep(input: PlanInput): Step[] {
  if (true !== input.detection.webGlSubtree) return [];
  return [
    {
      title: 'WebGL canvas is not observable',
      target: 'package.json',
      status: StepStatus.NOTICE,
      detail: WEBGL_CANVAS_LIMIT_NOTE,
    },
  ];
}
