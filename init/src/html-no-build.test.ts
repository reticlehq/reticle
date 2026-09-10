/**
 * A page with no build step CAN load the SDK, and `init` used to say it could not.
 *
 * The manual snippet told plain-static-HTML users that "the browser can't resolve the bare
 * '@reticlehq/react' import, so bundle the SDK once (e.g. `npx esbuild`) or serve the page through
 * a dev server". True of a BARE specifier and false of the thing that matters: a CDN URL resolves in
 * any browser, needs no npm, no bundler and no package.json.
 *
 * That sentence was the end of the road for every server-rendered app we hear from: FastAPI and
 * Flask serving static HTML, Django, Streamlit, Rails. Each of them was told by `init` to go and
 * build a JavaScript pipeline they do not have, in order to use a tool that needed no such thing.
 *
 * Verified end to end before this was written, not reasoned about: a plain page served by
 * `python3 -m http.server`, one `<script type="module">` importing from a CDN, produced a connected
 * session, a snapshot, and two `reticle_act_and_wait` verdicts of `verified: "yes"`.
 *
 * A snippet test, for the same reason as `snippets-compile.test.ts` and `snippet-token.test.ts`:
 * this string is never parsed, linted or executed inside this repo. It only ever runs on a
 * stranger's machine, so the only thing standing between a typo and a stranger is this file.
 */

import { describe, expect, it } from 'vitest';
import { htmlManual } from './snippets.js';
import { RETICLE_VERSION } from './version.js';

const snippet = htmlManual(4400, 'demo', 'tok_abc123');

describe('the no-build-step path', () => {
  it('is offered at all', () => {
    expect(snippet).toContain('script type="module"');
  });

  it('does not tell a static page to go and build a bundler pipeline', () => {
    expect(snippet).not.toMatch(/esbuild/i);
    expect(snippet).not.toMatch(/can'?t resolve the bare/i);
  });

  it('imports from a URL, which is the whole reason it works', () => {
    // A bare specifier is exactly what does NOT resolve in a plain page, and shipping one here
    // would reintroduce the original defect while looking like the fix.
    const line = snippet.split('\n').find((l) => l.includes('import { reticle }')) ?? '';
    expect(line).toMatch(/https:\/\//);
  });

  it('pins the SDK to this server version, so the two cannot drift', () => {
    // An unpinned CDN import silently upgrades the page SDK underneath a daemon that did not move,
    // which is the `version_skew` failure arriving by a new route.
    expect(snippet).toContain(`@${RETICLE_VERSION}`);
  });
});

describe('the bundled-app path does not prescribe the guard that loses the setup', () => {
  it('does not guard the connect on hostname === localhost', () => {
    // Reported from the field: on a dev host that is a hosts-file alias (the normal setup for
    // white-label and multi-tenant apps) this guard is false, so the connect never runs, nothing is
    // logged, and every other check stays green. It cost one reporter their entire setup. SKILL.md
    // has forbidden it in prose for two releases while `init` kept printing it.
    expect(snippet).not.toMatch(/hostname\s*===\s*'localhost'/);
  });

  it('still keeps the connect out of a production bundle', () => {
    // Removing the guard entirely would ship the SDK to production, which is worse than the bug.
    expect(snippet).toMatch(/NODE_ENV|import\.meta\.env\.DEV/);
  });

  it('names allowNonLocalhost, the flag that is invisible from the daemon side', () => {
    // The refusal happens page-side, so the daemon sees silence and `doctor` sees a healthy daemon.
    // If the snippet does not name the flag, nothing else the user can run ever will.
    expect(snippet).toContain('allowNonLocalhost');
  });
});
