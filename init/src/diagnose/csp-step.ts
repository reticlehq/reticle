/**
 * The plan's Content-Security-Policy step: the one check that runs before any framework's wiring,
 * because a policy that refuses the bridge makes every other step moot.
 */

import { RETICLE_DEFAULT_PORT } from '@reticlehq/core';
import { Framework } from '@/detect/detect.js';
import { StepStatus, type PlanInput, type Step } from '@/plan/plan-types.js';
import {
  CSP_STEP_TITLE,
  cspPatchedDetail,
  externalScriptRemedy,
  patchCspMetaConnectSrc,
} from './csp-check.js';
import { diagnoseWebCsp, type WebCspOptions } from './csp-doctor.js';

/**
 * How the app connects, as the CSP diagnosis needs to know it. Only the plain-HTML path pastes an
 * inline snippet, so only there can `script-src` stop the connect; see WebCspOptions.
 *
 * Shared with `reticle doctor`, which reads the framework `init` stamped into `.reticle.json`. It
 * used to assume the inline snippet for every app, so on electron-vite it reported the inline rule
 * while `init` reported the connect-src block that actually stops the bridge. Unknown wiring keeps
 * the conservative default.
 */
export function webCspOptionsFor(framework: string | undefined): WebCspOptions {
  return framework === undefined ? {} : { inlineSnippet: Framework.HTML === framework };
}

/**
 * A Content-Security-Policy whose `connect-src` excludes the bridge, said out loud at install time.
 *
 * Both reported cases were Next apps where `init` printed success for every step and the app then
 * never connected: the browser blocked the WebSocket and reported it in its own console, which
 * nothing on this side reads. It was a NOTICE, and on electron-vite's own template that meant init
 * waited out its whole connect budget without saying the app could not connect. So a `<meta>` policy
 * in the app's HTML is now edited to admit the bridge, and a policy anywhere else is a blocking ⚠
 * carrying the exact text to paste.
 */
export function cspStep(input: PlanInput): Step[] {
  // Reads the SAME list `reticle doctor` reads. It used to read a hand-written pair —
  // `[nextConfigSource, nextLayout?.source]` — while csp-doctor.ts already carried the full set
  // including `index.html`, which is where every Vite and Electron app declares its policy. So the
  // command you run BEFORE anything works checked less than the one you run after it has failed.
  //
  // Measured on MarkText, a production Electron editor: its renderer sets `default-src 'self'` with
  // no `connect-src`, the browser blocked the bridge WebSocket, and `init` printed a clean plan. The
  // daemon cannot see a dial that never left the page, so nothing anywhere said why — and the check
  // that would have said it was sitting one import away.
  // The pre-read Next sources are folded in ON TOP of the shared list, not replaced by it: init
  // resolves `nextConfigFile` across more spellings than CSP_FILES names (`.mts`, for one), and a
  // layout is found by search rather than by a fixed path. Two sources of the same truth is the
  // problem being fixed here — one of them being a SUPERSET is not.
  const extra: Record<string, string | undefined> = {
    ...(input.nextConfigFile !== null && input.nextConfigFile !== undefined
      ? { [input.nextConfigFile]: input.nextConfigSource ?? undefined }
      : {}),
    ...(input.nextLayout ? { [input.nextLayout.path]: input.nextLayout.source } : {}),
  };
  const read = (file: string): string | undefined => extra[file] ?? input.cspSources?.[file];
  const port = input.options.port ?? RETICLE_DEFAULT_PORT;
  const findings = diagnoseWebCsp(
    read,
    port,
    [...Object.keys(extra)],
    webCspOptionsFor(input.detection.framework),
  );
  const first = findings[0];
  if (first === undefined) return [];
  // A `<meta>` policy in the app's own HTML is edited in place. Anything else — a header built in
  // next.config, middleware, a host's config — is a ⚠ that fails init: the browser is guaranteed to
  // refuse the socket, and a NOTICE let init wait out its whole budget without saying so.
  const source = read(first.file);
  const patched =
    first.file.endsWith('.html') && source !== undefined && first.fix !== externalScriptRemedy()
      ? patchCspMetaConnectSrc(source, port)
      : undefined;
  if (patched !== undefined) {
    return [
      {
        title: CSP_STEP_TITLE,
        target: first.file,
        status: StepStatus.APPLY,
        detail: cspPatchedDetail(port),
        write: { path: first.file, content: patched },
      },
    ];
  }
  return [
    {
      title: CSP_STEP_TITLE,
      target: first.file,
      status: StepStatus.MANUAL,
      // `problem` already ends with the text to paste; `fix` is the same sentence for callers that
      // want it on its own (doctor renders them separately). Printing both said it twice.
      detail: first.problem,
    },
  ];
}
