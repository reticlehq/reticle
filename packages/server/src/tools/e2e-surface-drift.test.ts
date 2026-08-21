import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools.js';
import { ReticleTool } from './tool-names.js';

/**
 * Every `reticle_*` tool an e2e spec calls must still exist on the surface.
 *
 * This exists because the opposite happened and nothing noticed. A consolidation merged 56 tools down
 * to 41 — `reticle_record_start`/`_stop` became `reticle_record { action }`, `reticle_end_session`
 * became `reticle_session { action: 'end' }`, `reticle_flow_list` became `reticle_flow { action }` —
 * and four specs kept calling the old names. They died on `TOOLS.find(...)` returning undefined,
 * taking flow record/replay, self-heal, run history and live control with them, across bench-app AND
 * next-smoke. That is a whole framework's worth of coverage, dark for an unknown number of commits.
 *
 * It went unnoticed because the e2e battery needs three servers and ~8 minutes (measured; it was
 * documented as "~20 min" for months, and briefly as "~70s" — both wrong), so it is not in
 * `test:unit` — which is what actually runs. The battery cannot move into the unit gate, but the
 * failure mode that killed it is a name lookup, and a name lookup is checkable in milliseconds.
 *
 * So this is deliberately NOT an e2e test. It is a static cross-check placed in the gate that runs,
 * because the pattern in this repo is unambiguous: every rule a machine enforces has held, and every
 * rule left to prose has been violated. A renamed tool now fails here, in a second, instead of
 * silently deleting a spec's coverage.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const SPEC_DIR = join(REPO, 'apps', 'e2e', 'specs');
/**
 * The bench harnesses drive the SAME tool surface and rot the SAME way — which is not hypothetical:
 * the identical 56->41 consolidation that killed four e2e specs ALSO killed nine harnesses under
 * bench/harness, and this guard did not cover them because it was written to the shape of the first
 * incident instead of the shape of the failure. They called reticle_record_start/stop long after
 * those became reticle_record{action}; every replay, determinism and regression-efficiency number in
 * bench/ was produced by a harness that could not call its own tool, and the published
 * "128-2574x cheaper" claim traces back to one of them. Guarding one directory against a
 * repo-wide failure mode is what let it happen twice.
 */
const BENCH_DIR = join(REPO, 'bench');

/**
 * And the demo harnesses under `apps/`, because it happened a THIRD time exactly as predicted.
 *
 * The note above ends "guarding one directory against a repo-wide failure mode is what let it happen
 * twice", and then the guard was extended to a second directory rather than to the failure. So
 * `apps/vibe-builder-demo/qa` kept calling `reticle_wait_ready` after it was retired from the
 * surface, and every one of that demo's five steps died on `TOOLS.find(...).handler` — the identical
 * crash, in a demo whose whole point is showing Reticle catching what other gates miss.
 *
 * Scanned as a tree rather than a list of known directories: the next harness will be written
 * somewhere none of us predicted, and a guard that has to be told about it is a guard that will miss
 * it again.
 */
const APPS_DIR = join(REPO, 'apps');

/** Tool names referenced as string literals in a spec, e.g. T('reticle_query', …). */
const TOOL_REF = /'(reticle_[a-z0-9_]+)'/g;

/**
 * The universe this guard judges against: names DECLARED as tools.
 *
 * Matching every `reticle_*` token instead flagged 23 telemetry event codes and CLI log identifiers
 * (`reticle_status`, `reticle_daemon_stopped`) that were never tools and never will be. A name is
 * only evidence of drift if it was a tool once and is not on the surface now — which is exactly what
 * a consolidation leaves behind.
 */
const DECLARED_TOOLS = new Set<string>(Object.values(ReticleTool));

/**
 * Names that ARE callable, just not in the default profile — so naming them in guidance is correct.
 *
 * `TOOLS` is one profile's surface, not the universe. The progressive-disclosure tools are advertised
 * only when that profile is active, and treating their absence from the default list as drift would
 * flag guidance that is exactly right for the reader who has them. This is the distinction the guard
 * exists to draw: a FACADE MEMBER (`reticle_flow_list`) cannot be called by its own name in any
 * profile and must not be advertised as if it could; a profile-gated tool can.
 */
const PROFILE_GATED = new Set<string>([ReticleTool.RUN, ReticleTool.TOOLS]);

/**
 * Names a spec may reference despite being absent from the advertised surface, each with the reason.
 *
 * "Absent" is not the same as "gone", and conflating them cost me a wrong claim in three files: a tool
 * can be RETIRED — handler intact, deliberately unadvertised because something else covers it — and
 * reading only the missing name looks identical to a lost capability. Every entry here states which
 * it is, so the next reader does not have to re-derive it from tools.ts.
 */
const KNOWN_REMOVED = new Map<string, string>([
  [
    'reticle_run_record',
    'RETIRED from the surface, not removed: tools.ts RETIRED_FROM_SURFACE records that flow_replay already auto-records run outcomes, so a manual append was redundant. The handler still exists and works; it is simply not advertised. An earlier note here claimed the capability was lost — it was not, and the claim came from reading a missing tool name without checking the retirement list.',
  ],
  [
    'reticle_record_stop',
    'MERGED into reticle_record { action: "stop" }, and named in a spec on purpose rather than called. `skill-one-call-paths-test` asserts that this spelling is still refused WITH the redirect, because it is the mistake a draft of SKILL.md actually made — the instructions would have been refused at runtime while reading perfectly sensibly. A reference that exists to prove a name is gone is the one case this guard cannot tell from a call, so it is exempted here rather than obscured in the spec.',
  ],
]);

function specFiles(): string[] {
  return readdirSync(SPEC_DIR).filter((f) => f.endsWith('.mjs'));
}

/** Every .mjs under a directory, recursively — harnesses live several directories deep. */
function harnessFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if ('node_modules' === entry || 'dist' === entry || '.next' === entry) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...harnessFiles(full));
    else if (entry.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const benchFiles = (): string[] => harnessFiles(BENCH_DIR);
/**
 * Everything under `apps/` that drives the tool surface, minus the e2e specs the first guard already
 * covers by name. Deduped rather than excluded by path, so a spec moving does not silently drop it
 * from both guards at once.
 */
const appHarnessFiles = (): string[] =>
  harnessFiles(APPS_DIR).filter((f) => !f.startsWith(SPEC_DIR));

describe('e2e specs do not reference tools that no longer exist', () => {
  const advertised = new Set(TOOLS.map((t) => t.name));

  it('finds spec files to check (a passing test over zero specs proves nothing)', () => {
    expect(specFiles().length).toBeGreaterThan(5);
  });

  for (const file of specFiles()) {
    it(`${file} calls only tools that are on the surface`, () => {
      const text = readFileSync(join(SPEC_DIR, file), 'utf8');
      const referenced = [...text.matchAll(TOOL_REF)].map((m) => m[1]);
      // Only a name that WAS a tool is evidence of drift. A spec may legitimately quote a
      // telemetry event code (`reticle_installed`) or a store name, and flagging those told the
      // author to "update the spec" about a string that was never a tool and never will be — a guard
      // that is confidently wrong is worse than one that is silent, because the fix it demands is
      // impossible. Same rule the guidance guards below use.
      const missing = [...new Set(referenced)].filter(
        (n) =>
          n !== undefined &&
          DECLARED_TOOLS.has(n) &&
          !advertised.has(n) &&
          !PROFILE_GATED.has(n) &&
          !KNOWN_REMOVED.has(n),
      );
      expect(
        missing,
        `${file} references ${missing.join(', ')} — renamed or removed from the tool surface. ` +
          'Update the spec, or add the name to KNOWN_REMOVED with the reason if the capability is ' +
          'genuinely gone.',
      ).toEqual([]);
    });
  }

  it('every KNOWN_REMOVED entry is actually removed — stale exemptions rot', () => {
    for (const [name, why] of KNOWN_REMOVED) {
      expect(
        advertised.has(name),
        `${name} is back on the surface; drop its exemption (${why})`,
      ).toBe(false);
    }
  });
});

describe('bench harnesses do not reference tools that no longer exist', () => {
  const advertised = new Set(TOOLS.map((t) => t.name));

  it('finds bench harnesses to check', () => {
    expect(benchFiles().length).toBeGreaterThan(10);
  });

  it('every reticle_* name a bench harness calls is on the surface', () => {
    const broken: string[] = [];
    for (const file of benchFiles()) {
      const text = readFileSync(file, 'utf8');
      // Only names being CALLED — a tool name inside a comment or a results key is not a call.
      const called = [...text.matchAll(/callTool\(\s*'(reticle_[a-z0-9_]+)'/g)].map((m) => m[1]);
      for (const name of new Set(called)) {
        if (name !== undefined && !advertised.has(name) && !KNOWN_REMOVED.has(name)) {
          broken.push(`${file.slice(REPO.length + 1)} -> ${name}`);
        }
      }
    }
    expect(
      broken,
      'These bench harnesses call tools that are not on the surface. They will fail at runtime and ' +
        'produce a number anyway unless the harness checks isError. Fix the call, or add the name to ' +
        'KNOWN_REMOVED with the reason.',
    ).toEqual([]);
  });
});

describe('demo harnesses under apps/ do not reference tools that no longer exist', () => {
  const advertised = new Set(TOOLS.map((t) => t.name));

  it('finds app harnesses to check', () => {
    expect(appHarnessFiles().length).toBeGreaterThan(0);
  });

  it('every reticle_* name an app harness calls is on the surface', () => {
    // Matched by quoted name rather than by `callTool(`, because these harnesses dispatch their own
    // way — vibe-builder-demo does `TOOLS.find((t) => t.name === name).handler(...)`, which is the
    // line that actually threw. Narrowed by DECLARED_TOOLS for the same reason as the spec guard: a
    // quoted `reticle_installed` is a telemetry code, not a dead tool, and demanding a fix for a
    // name that was never a tool is worse than silence.
    const broken: string[] = [];
    for (const file of appHarnessFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const match of new Set([...text.matchAll(TOOL_REF)].map((m) => m[1]))) {
        if (
          match !== undefined &&
          DECLARED_TOOLS.has(match) &&
          !advertised.has(match) &&
          !PROFILE_GATED.has(match) &&
          !KNOWN_REMOVED.has(match)
        ) {
          broken.push(`${file.slice(REPO.length + 1)} -> ${match}`);
        }
      }
    }
    expect(
      broken,
      'These demo harnesses call tools that are not on the surface. They die on ' +
        '`TOOLS.find(...).handler` at runtime, which reads as the demo being broken rather than as ' +
        'the tool having been renamed. Fix the call, or add the name to KNOWN_REMOVED with the reason.',
    ).toEqual([]);
  });
});

/**
 * The guidance the surface SHIPS is a caller too — and the one an agent actually follows.
 *
 * The two guards above scan callers written as code: specs and harnesses referencing `'reticle_x'`
 * as string literals. They cannot see a tool name embedded in ADVICE — a tool description, an error
 * message, a readiness banner — and that is where the same consolidation rotted a third time. Six
 * user-facing strings still told an agent to call `reticle_record_start`/`_stop` long after those
 * became `reticle_record { action }`, including `reticle_discover`'s own description of the flow
 * workflow and the error you get when a recording is missing. An agent following that guidance
 * verbatim gets "tool not found" and has no way to know the advice was stale rather than its own
 * call being wrong.
 *
 * This guard is deliberately shaped to the FAILURE (a dead name reaching a user) rather than to the
 * incident (specs, then harnesses, then prose).
 */
const SERVER_SRC = join(HERE, '..');
/** Any reticle_* name mentioned anywhere in a source file, quoted or embedded in prose. */
const ANY_TOOL_MENTION = /reticle_[a-z0-9_]+/g;

function serverSources(dir: string = SERVER_SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if ('node_modules' === entry || 'dist' === entry) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...serverSources(full));
    // tool-names.ts DECLARES the constants; the names there are the vocabulary, not advice.
    else if (entry.endsWith('.ts') && !entry.includes('.test.') && entry !== 'tool-names.ts')
      out.push(full);
  }
  return out;
}

describe('user-facing guidance never names a tool an agent cannot call', () => {
  const advertised = new Set(TOOLS.map((t) => t.name));

  it('finds source files to check', () => {
    expect(serverSources().length).toBeGreaterThan(20);
  });

  it('every reticle_* name in shipped guidance resolves to a live tool', () => {
    const dead: string[] = [];
    for (const file of serverSources()) {
      const text = readFileSync(file, 'utf8');
      // Per LINE, not per file: a whole-file search matches any quote anywhere before the name, which
      // flags ordinary code comments describing the module. Only a name inside a string on its own line
      // is guidance that ships.
      for (const line of text.split('\n')) {
        if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue;
        for (const match of line.match(ANY_TOOL_MENTION) ?? []) {
          if (PROFILE_GATED.has(match)) continue;
          if (!DECLARED_TOOLS.has(match) || advertised.has(match) || KNOWN_REMOVED.has(match))
            continue;
          // A facade is BUILT from its members' constants — `members: { start: ReticleTool.RECORD_START }`
          // wires the surface rather than advising anyone to call it. Only a bare literal is advice.
          if (!/['`"]/.test(line.slice(0, line.indexOf(match)))) continue;
          dead.push(`${file.replace(SERVER_SRC, '')}: ${match}`);
        }
      }
    }
    expect(dead, `guidance names tools that are not on the surface:\n${dead.join('\n')}`).toEqual(
      [],
    );
  });
});

/**
 * The docs a USER pastes are guidance too, and the furthest-out audience.
 *
 * `skills/install-and-verify/SKILL.md` is the same guidance again, published to the agent-skill registry, where
 * the reader arrived by search and has never seen this repo. It is in scope for the same reason.
 *
 * `SKILL.md` is the canonical paste-URL for integrating Reticle and `docs/` ships with it, so a dead
 * tool name there reaches someone with no way at all to check it against the surface. Judged by the
 * same rule as shipped code — a name is drift only if it was DECLARED a tool and is not callable —
 * because prose legitimately mentions Rust symbols (`reticle_tauri::reticle_capture`), store names
 * (`__reticle_renders`) and telemetry codes (`reticle_installed`), none of which are tools. Matching
 * every `reticle_*` token flags eight of those and nothing real, which is how a guard becomes noise
 * and then gets ignored.
 */
describe('shipped docs never name a tool a reader cannot call', () => {
  const advertised = new Set(TOOLS.map((t) => t.name));
  const DOCS = join(REPO, 'docs');

  function docFiles(dir: string = DOCS): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      if ('node_modules' === entry || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...docFiles(full));
      // `.mdx` as well as `.md`. The reference pages are all `.mdx` and every one of them is a
      // list of tool names, so scanning only `.md` meant the guard was blind to precisely the
      // pages most likely to name a tool wrong.
      else if (entry.endsWith('.md') || entry.endsWith('.mdx')) out.push(full);
    }
    return out;
  }

  /**
   * The published skill, which is the same guidance again for a reader who has never seen this repo.
   *
   * They arrived from a skill registry, they have no checkout, and the body delegates its detail to
   * `references/`, so a dead name in one of those files reaches someone with no way at all to check
   * it. Same rule, wider net.
   */
  function skillFiles(dir: string = join(REPO, 'skills')): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out.push(...skillFiles(full));
      else if (entry.endsWith('.md')) out.push(full);
    }
    return out;
  }

  it('finds docs to check', () => {
    expect(docFiles().length).toBeGreaterThan(3);
  });

  /**
   * The published package READMEs are in scope, and they are the most-read docs we ship.
   *
   * This guard checked `docs/` and `SKILL.md` only, so `packages/server/README.md` was advertising
   * `reticle_baseline_save`, `reticle_baseline_list` and `reticle_diff` — three names no profile
   * registers (the real tools are `reticle_baseline` and `reticle_visual_diff`) — to every reader on
   * npm, and passed. The logic here was always right; it was simply pointed at the wrong files.
   */
  function shippedReadmes(): string[] {
    const out = [join(REPO, 'README.md')];
    const pkgs = join(REPO, 'packages');
    for (const entry of readdirSync(pkgs)) {
      const readme = join(pkgs, entry, 'README.md');
      if (existsSync(readme)) out.push(readme);
    }
    return out;
  }

  it('finds shipped READMEs to check', () => {
    expect(shippedReadmes().length).toBeGreaterThan(3);
  });

  it('every declared tool name in the docs is one a reader can actually call', () => {
    const dead: string[] = [];
    for (const file of [
      ...docFiles(),
      ...shippedReadmes(),
      join(REPO, 'SKILL.md'),
      ...skillFiles(),
    ]) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.match(ANY_TOOL_MENTION) ?? []) {
        if (!DECLARED_TOOLS.has(match) || advertised.has(match)) continue;
        if (PROFILE_GATED.has(match) || KNOWN_REMOVED.has(match)) continue;
        dead.push(`${file.replace(REPO, '')}: ${match}`);
      }
    }
    expect(dead, `docs name tools that are not callable:\n${dead.join('\n')}`).toEqual([]);
  });

  /**
   * `npx reticle` runs SOMEBODY ELSE'S PACKAGE.
   *
   * `reticle` is a bin name `@reticlehq/server` installs, not a package on npm — the name belongs to
   * an unrelated project. `npx <name>` resolves the PACKAGE, so `npx reticle init` fetches a
   * stranger's code from the registry unless a local bin already shadows it, which on a first install
   * it cannot. This shipped on 110 lines across 36 doc pages, including the first command on the
   * quickstart, where by definition nothing of ours is installed yet.
   *
   * The README already states the rule in prose and the docs violated it anyway, which is the usual
   * result of a rule a machine does not enforce. Matched on `npx reticle` only: a BARE `reticle
   * doctor` in captured CLI output is quoting the bin correctly and is not this bug.
   */
  it('no shipped doc tells a reader to npx a package we do not own', () => {
    const wrong: string[] = [];
    for (const file of [
      ...docFiles(),
      ...shippedReadmes(),
      join(REPO, 'SKILL.md'),
      ...skillFiles(),
    ]) {
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/npx\s+(--[a-z-]+\s+)*reticle(?![a-z@/-])/.test(line))
          wrong.push(`${file.replace(REPO, '')}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      wrong,
      `these tell a reader to run an npm package we do not own — use \`npx @reticlehq/server\`:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * A runnable shell block must never assume the `reticle` bin is on the reader's PATH.
   *
   * The reader of these pages installed nothing: they arrived from a paste-URL or a registry and
   * reach for `npx`. A bare `reticle telemetry disable` in a bash fence is a command that either
   * fails with "command not found" or, worse, gets prefixed with `npx` by an agent trying to be
   * helpful, which fetches the unrelated package named `reticle`.
   *
   * Scoped to fences the reader would COPY (bash/sh/shell/console) rather than to every mention.
   * Captured CLI output legitimately prints `reticle doctor` as its own header, and the usage block
   * legitimately lists commands by their bin name; neither is an instruction, and rewriting the 180
   * inline prose references would make the prose worse without helping anybody.
   *
   * The earlier sweep of this repo matched `^reticle ` and therefore missed the one real offender,
   * which was indented two spaces inside a list item. Hence a fence-aware check rather than a
   * line-prefix one.
   */
  it('no runnable shell block assumes the reticle bin is on PATH', () => {
    const RUNNABLE = new Set(['bash', 'sh', 'shell', 'console']);
    const bare: string[] = [];
    for (const file of [
      ...docFiles(),
      ...shippedReadmes(),
      join(REPO, 'SKILL.md'),
      ...skillFiles(),
    ]) {
      let fence: string | null = null;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          const open = /^\s*```(\w*)/.exec(line);
          if (open) {
            fence = null === fence ? (open[1] ?? '') : null;
            return;
          }
          if (null === fence || !RUNNABLE.has(fence)) return;
          if (/^\s*(\$ )?reticle\s+[a-z]/.test(line))
            bare.push(`${file.replace(REPO, '')}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(
      bare,
      `these shell blocks assume the \`reticle\` bin is installed. The reader used npx to get here, so write \`npx @reticlehq/server <command>\`:\n${bare.join('\n')}`,
    ).toEqual([]);
  });

  /**
   * The docs site does not use em dashes. Anywhere: not in a heading, not in body text.
   *
   * A house style rule rather than a correctness one, which is exactly why it needs a machine. The
   * docs were swept clean of them once and the very next edit to `frameworks.mdx` put two back, by
   * someone who had been told the rule an hour earlier. That is the pattern this file already names:
   * every rule enforced by a check has held, and every rule left to prose has been violated.
   *
   * Scoped to the docs site and the published skill files: `docs/`, `SKILL.md`, and `skills/`.
   * `CHANGELOG.md` and the source comments are out of scope for good: a changelog is a written
   * record in a different voice.
   *
   * PROSE only. Fenced blocks and inline code spans are skipped, because a good share of the dashes
   * in these pages sit inside CAPTURED CLI OUTPUT — `doctor`'s diagnosis lines, `kill`'s refusal JSON
   * — and those are quotations of what the program actually prints. "Fixing" them would make the docs
   * disagree with the binary, which is a worse defect than the one this rule is about.
   */
  it('no docs page uses an em dash in prose', () => {
    const wrong: string[] = [];
    for (const file of [...docFiles(), join(REPO, 'SKILL.md'), ...skillFiles()]) {
      let inFence = false;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (line.trimStart().startsWith('```')) {
            inFence = !inFence;
            return;
          }
          if (inFence) return;
          if (line.replace(/`[^`]*`/g, '').includes('—')) {
            wrong.push(`${file.replace(REPO, '')}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(
      wrong,
      `these use an em dash in prose. The docs style is to rewrite the sentence (a comma, a colon, ` +
        `a full stop, or two sentences) rather than to reach for the dash. Captured CLI output is ` +
        `already exempt, so a hit here is prose:\n${wrong.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * The surface has to point at the verdict, because the surface is what the agent reads.
 *
 * Measured over a day of real telemetry: `reticle_act` 50 calls, `reticle_act_and_wait` 14 — so 78%
 * of the actions agents drove produced no verdict at all, and `verification_completed` was 2. The
 * cause is in the descriptions: `reticle_act` sent the reader to `reticle_observe`, which is a LOOK,
 * and never mentioned `reticle_act_and_wait` at all. `act_and_wait`'s own description calls itself
 * "one hop for the act->observe->assert loop" — but only somebody who already found it ever reads
 * that.
 *
 * Tool definitions are re-sent to the model on EVERY turn, so this is a clause, not a paragraph.
 */
describe('the acting tools point at the one that produces a verdict', () => {
  const act = TOOLS.find((t) => t.name === ReticleTool.ACT);

  it('reticle_act names reticle_act_and_wait as the way to get a verdict', () => {
    expect(act, 'reticle_act is not on the surface').toBeDefined();
    expect(
      act?.description,
      'reticle_act never mentions act_and_wait, so an agent reading it has no way to learn that ' +
        'asserting is one argument away — which is how 78% of actions end with no verdict.',
    ).toContain(ReticleTool.ACT_AND_WAIT);
  });

  it('and says what act_and_wait gives you, not merely that it exists', () => {
    expect(act?.description).toMatch(/verdict|assert/i);
  });

  /**
   * Mentioning it was not enough, and we now have the number. In one day of telemetry agents called
   * `reticle_act` 179 times and `reticle_act_and_wait` 62 — and `act_and_wait` produced ALL EIGHT
   * action-derived defects while `act` produced none. `act` is the most-used tool in the product and
   * has never found anything.
   *
   * The steer was already in the description, 252 characters in, behind the full action enum. An
   * agent skimming to pick a tool reads the opening clause — "Execute one action against a ref:
   * click|dblclick|…" — which is a complete and satisfying answer to "how do I click something", and
   * stops. Position is the fix, not wording.
   *
   * 160 chars is roughly the opening sentence. This asserts the choice is made before the reference
   * material starts, and it is a BOUND, not a duration — it cannot flake.
   */
  const STEER_MUST_APPEAR_WITHIN = 160;

  it('puts the steer in the opening sentence, not behind the action enum', () => {
    const at = act?.description.indexOf(ReticleTool.ACT_AND_WAIT) ?? -1;
    expect(at).toBeGreaterThanOrEqual(0);
    expect(
      at,
      `act_and_wait is mentioned ${String(at)} chars in. An agent picking a tool reads the first ` +
        'clause and stops — which is how the most-used tool in the product has zero findings.',
    ).toBeLessThan(STEER_MUST_APPEAR_WITHIN);
  });
});
