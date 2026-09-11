import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, knownCommand, UNKNOWN_COMMAND } from '../cli/cli-parse.js';

/**
 * Every command the docs tell somebody to run is EXECUTED against the shipped parser, not read.
 *
 * The existing docs guards check names: that a `reticle_*` tool exists, that nobody is told to npx a
 * package we do not own, that a shell block does not assume a bin on PATH. None of them can tell
 * whether `reticle verify --timeout 60000` is still a thing the CLI accepts. A renamed flag, a
 * retired subcommand or a moved argument leaves prose that renders perfectly, reviews cleanly, and
 * fails the first time a reader pastes it.
 *
 * `parseCliArgs` is the real oracle for that. It is the same function `cli.ts` calls, it returns
 * `{ kind: 'error' }` for an unknown command or an unknown argument, and it is pure, so every
 * documented invocation can be run through it in milliseconds with no daemon, no network and no
 * side effects. Running the binary in a subprocess would prove slightly more and cost a build plus a
 * sandbox per command; the parser is where the failure this guards against actually lives.
 *
 * Scoped to RUNNABLE fences (bash/sh/shell/console). A usage block lists commands with placeholder
 * syntax (`verify <url> [--headed]`) which is documentation of the shape, not an instruction, and
 * feeding it to the parser would fail on the angle brackets rather than on anything real.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const RUNNABLE_FENCES: ReadonlySet<string> = new Set(['bash', 'sh', 'shell', 'console']);

/** The invocation prefix the docs use everywhere, optionally version-pinned. */
const INVOCATION = /(?:^|\s)npx\s+(?:-y\s+|--yes\s+)?@reticlehq\/server(?:@[\w.-]+)?\s+(.+)$/;

/** Files a reader can copy from: the docs site, the shipped READMEs, the paste-URL, the skills. */
function textFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if ('node_modules' === entry || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) textFiles(full, out);
    else if (entry.endsWith('.md') || entry.endsWith('.mdx')) out.push(full);
  }
  return out;
}

function sources(): string[] {
  const out = [join(REPO, 'README.md'), join(REPO, 'SKILL.md')];
  out.push(...textFiles(join(REPO, 'docs')), ...textFiles(join(REPO, 'skills')));
  const pkgs = join(REPO, 'packages');
  for (const entry of readdirSync(pkgs)) {
    const readme = join(pkgs, entry, 'README.md');
    if (existsSync(readme)) out.push(readme);
  }
  return out.filter(existsSync);
}

interface DocCommand {
  file: string;
  line: number;
  raw: string;
  argv: string[];
}

/**
 * Split a documented command line into argv.
 *
 * Deliberately simple: quoted strings survive as single tokens, and anything containing placeholder
 * syntax is dropped by the caller before it gets here. A shell-accurate tokenizer would be a
 * dependency and a source of its own bugs, for lines that are by construction short and literal.
 */
function tokenize(rest: string): string[] {
  return (rest.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((t) => t.replace(/^["']|["']$/g, ''));
}

/** A template rather than an instruction: `<command>`, `[--flag]`, or a trailing shell comment. */
function isTemplate(rest: string): boolean {
  return rest.includes('<') || rest.includes('[');
}

function documentedCommands(): DocCommand[] {
  const found: DocCommand[] = [];
  for (const file of sources()) {
    let fence: string | null = null;
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const open = /^\s*```(\w*)/.exec(line);
        if (open) {
          fence = null === fence ? (open[1] ?? '') : null;
          return;
        }
        if (null === fence || !RUNNABLE_FENCES.has(fence)) return;
        const m = INVOCATION.exec(line.replace(/\s+#.*$/, ''));
        const rest = m?.[1];
        if (rest === undefined || isTemplate(rest)) return;
        found.push({
          file: file.replace(REPO, ''),
          line: i + 1,
          raw: line.trim(),
          argv: tokenize(rest),
        });
      });
  }
  return found;
}

describe('every command the docs tell a reader to run is one the CLI still accepts', () => {
  const commands = documentedCommands();

  /**
   * A passing test over zero commands proves nothing, and this is the shape most likely to rot: a
   * fence-language change or a rename of the invocation prefix would silently empty the corpus and
   * leave a green check over no coverage at all.
   */
  it('finds documented commands to run', () => {
    expect(commands.length).toBeGreaterThan(10);
  });

  /**
   * The CLI has TWO dispatch paths, and a guard that knows about one is confidently wrong.
   *
   * `cli.ts` handles the cloud family (login / link / project / config / push / runs / regression /
   * share / whoami) BEFORE reaching the typed parser, because they are async and share a client. So
   * `parseCliArgs(['login'])` answers `unknown command 'login'` about a command that works perfectly,
   * and the first run of this guard duly reported four healthy doc lines as broken.
   *
   * Told apart by the error itself rather than by a hardcoded list, so a command moving between the
   * two paths does not need this file edited: `unknown command` for a name the CLI still recognises
   * means "dispatched elsewhere"; `unknown command` for a name it does not means the docs are naming
   * something that no longer exists; and `unknown argument` is a real failure on either path, because
   * a flag the parser rejects is a flag the reader cannot use.
   *
   * The pair of conditions has to be read together, which is why this is ONE assertion rather than
   * two. A first attempt also asserted separately that every documented subcommand is in the CLI's
   * known-command list, and that flagged `--help`, `-h`, `--version` and `-v`: flags in the command
   * position, which the parser accepts and a list of command NAMES cannot contain. The parser is the
   * authority on what runs; the name list only explains why a rejection is not a defect.
   */
  it('parses every one without an unknown command or unknown argument', () => {
    const rejected: string[] = [];
    for (const c of commands) {
      const result = parseCliArgs(c.argv, 4400);
      if ('error' !== result.kind) continue;
      const first = result.message.split('\n')[0] ?? '';
      const name = c.argv[0] ?? '';
      const dispatchedElsewhere =
        first.startsWith('unknown command') && knownCommand(name) !== UNKNOWN_COMMAND;
      if (dispatchedElsewhere) continue;
      rejected.push(`${c.file}:${c.line}: ${c.raw}\n    → ${first}`);
    }
    expect(
      rejected,
      `these documented commands no longer parse. A reader pasting them gets an error:\n${rejected.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * The same rule, applied to strings the PRODUCT prints.
 *
 * `lint:docs` reads markdown, and the worst instance of this defect was never in markdown: two
 * strings in `init/cra.ts` told a CRA user to run `npx reticle init`, printed into a project where
 * nothing of ours is installed. `npx reticle` resolves the npm package named `reticle`, which
 * belongs to an unrelated author, so the product's own repair instruction fetched and ran a
 * stranger's code. It shipped, and no guard could see it, because every guard pointed at docs.
 *
 * Scoped to `npx reticle` rather than to every mention of the bin: runtime messages legitimately
 * name `reticle mcp` and `reticle init` as processes and steps, and the CLI knows its own bin name.
 * The unrunnable, wrong-package form is the part that is never correct.
 */
describe('no shipped string tells a user to npx a package we do not own', () => {
  const SRC = join(REPO, 'packages');

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if ('node_modules' === entry || 'dist' === entry) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) sourceFiles(full, out);
      else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
    }
    return out;
  }

  it('finds source files to check', () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(50);
  });

  it('never emits `npx reticle`', () => {
    const bad: string[] = [];
    for (const file of sourceFiles(SRC)) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // The docblock in cli-parse.ts explains this exact hazard and has to quote it to do so.
          if (line.trimStart().startsWith('*')) return;
          if (/npx\s+reticle(?![a-z@/-])/.test(line))
            bad.push(`${file.replace(REPO, '')}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(
      bad,
      `these ship an instruction that runs somebody else's package:\n${bad.join('\n')}`,
    ).toEqual([]);
  });
});
