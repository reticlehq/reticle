import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SKILL_COPIES, syncSkill } from '../../scripts/sync-skill.mjs';

/**
 * Root `SKILL.md` is the one hand-written skill. `scripts/sync-skill.mjs` writes every other copy
 * from it: `docs/skill.md` (the docs host serves it), `plugins/reticle/SKILL.md` (the Claude Code plugin),
 * `skills/reticle/SKILL.md` (the skills CLI) and `skills/install-and-verify/SKILL.md` (an older name
 * for the same skill). Each copy is its own frontmatter plus the root body, with its own
 * install-source marker.
 *
 * The plugin and install-and-verify copies were hand restructures. They drifted from the root about
 * the permission rule, named a step that did not exist, and told agents to call a removed tool.
 */
// Asked rather than counted. A walk of `..` segments up to the repository is a statement about how
// deeply this package sits, not about the repository, and packages move -- when one did, every such
// walk quietly started reading a directory that does not exist.
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: import.meta.dirname,
  encoding: 'utf8',
}).trim();
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

/** Every skill under `skills/`, as repo-relative paths — read from disk so a new one is covered. */
const allSkillFiles = (): string[] =>
  readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `skills/${e.name}/SKILL.md`)
    .filter((rel) => existsSync(join(ROOT, rel)));

/**
 * Sentences every copy that states the permission rule must carry, verbatim. The generated copies
 * carry them because the root does; the check below stops a task skill from restating half of it.
 */
const SHARED_RULES = [
  'Your host asks the human to approve a command.',
  'That prompt belongs to the host. Never bypass or suppress it, and take a refusal as the answer.',
  '`init` writing a pre-approval rule for the `reticle` server is not that: it is a scoped, announced config change the human asked for by running the command, and it covers only Reticle',
  'No recognisable dev script in `package.json`.',
];

const GENERATED = SKILL_COPIES.map((copy) => copy.path);
const ALL_COPIES = ['SKILL.md', ...GENERATED];

describe('the skill copies agree about the rules', () => {
  it('carries every normative sentence in the canonical skill', () => {
    for (const rule of SHARED_RULES) {
      expect(read('SKILL.md'), `SKILL.md is missing: ${rule}`).toContain(rule);
    }
  });

  it('commits every generated copy exactly as `pnpm skill:sync` writes it', () => {
    for (const [path, text] of syncSkill(ROOT)) {
      expect(read(path), `${path} is out of date: run pnpm skill:sync`).toBe(text);
    }
  });

  /**
   * `npx skills add reticlehq/reticle --skill reticle` installed the whole 11 MB `docs/` directory as
   * the skill on macOS and Windows, because `docs/skill.md` matched `SKILL.md` on a case-insensitive
   * file system. On Linux it installed `plugin/`, whose text said the plugin had registered the MCP
   * server. The CLI reads the repository root one level deep before `skills/`, the first skill with
   * a name wins, and a named `--skill` also finds `internal` skills. So no directory at the root may
   * hold a skill named `reticle`, and the docs and plugin copies are `internal`.
   */
  it('lets the skills CLI find `reticle` only in skills/reticle', () => {
    const name = (text: string): string | undefined => /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const atRoot = readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'skills')
      .flatMap((e) =>
        readdirSync(join(ROOT, e.name))
          .filter((f) => 'skill.md' === f.toLowerCase())
          .map((f) => `${e.name}/${f}`),
      )
      .filter((rel) => 'reticle' === name(read(rel)));
    expect(atRoot, 'a root directory holds a skill named reticle').toEqual([]);
    const internal = /^\s+internal:\s*true$/m;
    for (const path of ['docs/skill.md', 'plugins/reticle/SKILL.md']) {
      expect(read(path), `${path} must declare metadata.internal: true`).toMatch(internal);
    }
    expect(read('skills/reticle/SKILL.md')).not.toMatch(internal);
  });

  /**
   * The anchor sentence is what makes the list above self-maintaining: any copy that talks about the
   * host's permission prompt must carry the whole rule, so a NEW copy cannot quietly restate half of
   * it. Without this, adding a fourth file re-creates exactly the drift this test was written for.
   */
  it('finds no copy outside the list restating the rule in part', () => {
    const anchor = 'That prompt belongs to the host.';
    const strays = allSkillFiles()
      .filter((f) => !ALL_COPIES.includes(f) && read(f).includes(anchor))
      .filter((f) => !SHARED_RULES.every((r) => read(f).includes(r)));
    expect(strays, `these state the rule but not all of it: ${strays.join(', ')}`).toEqual([]);
  });

  /**
   * The plugin's frontmatter version is what a host displays and what a user reports a bug against.
   * Stale, it names a release whose behaviour the file no longer describes — it once sat three minor
   * versions of install changes behind what was shipping.
   */
  it('declares the version actually being shipped, in every copy that declares one', () => {
    const shipped = (JSON.parse(read('server/package.json')) as { version: string }).version;
    for (const file of [...ALL_COPIES, ...allSkillFiles()]) {
      const declared = /^\s*version:\s*(.+)$/m.exec(read(file))?.[1]?.trim();
      // Not every copy has frontmatter — the canonical one has none at all.
      if (declared === undefined) continue;
      expect(declared, `${file} declares ${declared}, shipping ${shipped}`).toBe(shipped);
    }
  });

  /**
   * Each published channel must carry its OWN marker, or it is invisible.
   *
   * `resolveInstallSource` narrows one env var against a closed list, and install-source.ts states
   * the consequence plainly: these channels are "real ONLY where that channel's own copy of the
   * install command carries the marker… a copy that has not been updated is indistinguishable from
   * no channel at all". So a missing marker does not degrade the number, it silently moves a whole
   * distribution route into `unknown` — and `unknown` is already expected to be the largest bucket,
   * which is exactly what makes the loss unnoticeable.
   *
   * `npx_skill` shipped without one. The README now leads with the short `reticle connect` command;
   * making people type an attribution environment variable there would complicate the first-run
   * path. Its invocations intentionally fall into `unknown` rather than claiming a false channel.
   *
   * The plugin also sets the marker in the `env` of the MCP server it registers
   * (plugins/reticle/.claude-plugin/plugin.json); its skill copy carries the same channel.
   */
  it('carries the install-source marker in every channel that ships a command', () => {
    const channels = [
      ['SKILL.md', 'skill_file'],
      ['docs/skill.md', 'skill_file'],
      ['plugins/reticle/SKILL.md', 'plugin'],
      ['skills/reticle/SKILL.md', 'npx_skill'],
      ['skills/install-and-verify/SKILL.md', 'npx_skill'],
    ] as const;
    for (const [file, source] of channels) {
      expect(read(file), `${file} must attribute itself as ${source}`).toContain(
        `RETICLE_INSTALL_SOURCE=${source}`,
      );
    }
  });

  /**
   * `docs/skill.md` is what the docs host serves at `docs.reticle.sh/skill.md`, the URL the platform
   * hands agents. Without it the host published a skill it GENERATED from the docs, which disagreed
   * with this one and never named it (the docs-site gate went red on main on 2026-10-12), and the
   * platform's own link, `reticle.sh/SKILL.md`, was a 404. Frontmatter is its own; the body is the
   * canonical file, byte for byte, so an agent reads the same rules from every URL.
   */
  it('serves the canonical skill from the docs site, under its own frontmatter', () => {
    const served = read('docs/skill.md');
    const frontmatter = /^---\n[\s\S]*?\n---\n\n/.exec(served)?.[0];
    expect(frontmatter, 'docs/skill.md needs Agent Skills frontmatter').toBeDefined();
    expect(served.slice(frontmatter?.length ?? 0), 'copy SKILL.md into docs/skill.md').toBe(
      read('SKILL.md'),
    );
  });

  it('registers the plugin channel where the plugin actually declares it', () => {
    const manifest = read('plugins/reticle/.claude-plugin/plugin.json');
    expect(manifest).toContain('"RETICLE_INSTALL_SOURCE": "plugin"');
  });

  /**
   * The plugin pins its daemon to one server version, and its nudge pins `init` to the same one, so
   * the SDK that `init` installs speaks the daemon's contract. The plugin's skill copy said
   * `@latest`: after the next release, a plugin user got a newer SDK than the pinned daemon.
   */
  it('makes the plugin copy run the init of the server version the plugin pins', () => {
    const manifest = JSON.parse(read('plugins/reticle/.claude-plugin/plugin.json')) as {
      mcpServers: { reticle: { args: string[] } };
    };
    const pinned = manifest.mcpServers.reticle.args.find((a) => a.startsWith('@reticlehq/server@'));
    expect(pinned, 'plugin.json pins no @reticlehq/server version').toBeDefined();
    const copy = read('plugins/reticle/SKILL.md');
    expect(copy).toContain(`npx ${pinned ?? ''} init`);
    expect(copy).not.toContain('@reticlehq/server@latest init');
  });

  /**
   * EVERY skill that ships an install command, not the one somebody happened to open.
   *
   * `install-and-verify` was found missing its marker by inspection; `verify-unattended` was missing
   * it too and would have stayed missing, because a check written against a single file is a check
   * of that file. The list is read from disk so a skill added tomorrow is covered on the day it
   * lands rather than the day someone remembers.
   *
   * Both spellings count. Most skills carry it inline as an aside; `verify-unattended` exports it on
   * its own line, because that skill runs against a prefix allowlist and
   * `RETICLE_INSTALL_SOURCE=… npx …` no longer starts with `npx` — the marker must not cost a skill
   * the rule it tells the reader to depend on.
   */
  it('attributes the channel in every skill that tells a reader to install', () => {
    const installs = allSkillFiles().filter((f) =>
      /@reticlehq\/server(@latest)? init/.test(read(f)),
    );
    expect(
      installs.length,
      'no skill ships an install command — the filter is wrong',
    ).toBeGreaterThan(0);
    const unattributed = installs.filter(
      (f) => !read(f).includes('RETICLE_INSTALL_SOURCE=npx_skill'),
    );
    expect(
      unattributed,
      `these ship an install with no channel: ${unattributed.join(', ')}`,
    ).toEqual([]);
  });
});
