import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLS } from './tools.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const DOCS = join(REPO, 'docs');

/**
 * `docs/` serves two audiences — users and contributors — and for a long time nothing recorded which
 * was which. Twenty-five files sat in one flat directory, six of them invisible to the docs site, and
 * the only way to find out where a page belonged was to open it.
 *
 * `docs/README.md` is the index that fixes that, and `docs/docs.json` is what the published site
 * actually reads. An index is worth exactly as much as its accuracy, and one maintained by discipline
 * is wrong within two months — so the rule is a red build rather than a convention, the same way
 * `integration-coverage.test.ts` holds `apps/`.
 *
 * Every direction below is a silent failure if it goes unchecked:
 *   - a page nobody indexed is a page no contributor finds;
 *   - a page missing from `docs.json` is one no user can reach;
 *   - a page `docs.json` lists but that does not exist is a 404 on the published site;
 *   - a page without frontmatter renders with its slug as the title and no search description.
 */

const INDEX = 'README.md';

/** The site's own landing page. Mintlify serves it at `/` implicitly, so it is never in the nav. */
const HOME = 'index.mdx';

const docsIndex = () => readFileSync(join(DOCS, INDEX), 'utf8');

/**
 * Directories under `docs/` that hold no site pages.
 *
 * `matrix/` is generated machine output plus its own README (`apps/e2e/matrix.mjs` writes it and the
 * file says so); the rest are assets. Everything else under `docs/` is a published page, including
 * the nested ones.
 */
const NON_PAGE_DIRS = new Set(['images', 'logo', 'favicon', 'matrix']);

/**
 * Every page, including the nested ones.
 *
 * This walked only the top level until the reference grew a page per CLI command and a page per
 * package. Those live in `docs/cli/` and `docs/packages/`, and a flat scan reported the two
 * DIRECTORIES as unpublished docs while every real page inside them went unchecked: the gate was
 * loudly wrong about two things and silently blind to thirty-four.
 */
const markdownPages = (dir = DOCS, prefix = ''): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) {
      if (!NON_PAGE_DIRS.has(entry.name))
        out.push(...markdownPages(join(dir, entry.name), `${rel}/`));
      continue;
    }
    if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdx')) continue;
    if (rel === INDEX || rel === HOME) continue;
    out.push(rel);
  }
  return out;
};

/** Just the top-level pages: what `docs/README.md` is expected to list one by one. */
const topLevelPages = () => markdownPages().filter((f) => !f.includes('/'));

/** The page directories, which `docs/README.md` names as a group rather than row by row. */
const pageDirs = () => [
  ...new Set(
    markdownPages()
      .filter((f) => f.includes('/'))
      .map((f) => f.split('/')[0] ?? ''),
  ),
];

/** The file behind a nav slug, which may be authored as either `.md` or `.mdx`. */
const pageFile = (slug: string): string | null => {
  for (const ext of ['.md', '.mdx']) {
    const path = join(DOCS, `${slug}${ext}`);
    if (existsSync(path)) return path;
  }
  return null;
};

/** Slugs `docs.json` publishes, flattened out of the tab -> group -> pages nesting. */
const publishedSlugs = (): string[] => {
  const config: unknown = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8'));
  const slugs: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (null === node || 'object' !== typeof node) return;
    const record = node as Record<string, unknown>;
    if (Array.isArray(record.pages)) {
      for (const page of record.pages) {
        if ('string' === typeof page) slugs.push(page);
        else walk(page);
      }
    }
    Object.values(record).forEach(walk);
  };
  walk(config);
  return slugs;
};

describe('docs/README.md indexes every doc', () => {
  it('every top-level page is linked from the index', () => {
    const index = docsIndex();
    const unlisted = topLevelPages().filter((page) => !index.includes(`(${page})`));

    expect(
      unlisted,
      `These docs exist but are not in docs/README.md, so nobody will find them: ${unlisted.join(', ')}. ` +
        `Add each to the user table or the contributor table — the point of the index is that the ` +
        `two audiences are told apart.`,
    ).toEqual([]);
  });

  it('every page directory is named in the index', () => {
    // A row per page stops being useful once a directory holds one page per CLI command and one per
    // package: the index would be mostly index. The guarantee that matters (no page is unreachable)
    // belongs to the docs.json test below, which checks all of them individually. This one only has
    // to stop a whole directory going unmentioned to a human reading the repo.
    const index = docsIndex();
    const unmentioned = pageDirs().filter((dir) => !index.includes(`${dir}/`));

    expect(
      unmentioned,
      `These docs directories are not mentioned in docs/README.md: ${unmentioned.join(', ')}. ` +
        `Name the directory and say what is in it; the pages inside do not each need a row.`,
    ).toEqual([]);
  });
});

describe('docs/docs.json publishes every doc', () => {
  it('every page docs.json publishes actually exists', () => {
    const missing = publishedSlugs().filter((page) => null === pageFile(page));

    expect(
      missing,
      `docs.json publishes pages with no file behind them — each is a 404 on the docs site: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('every markdown page under docs/ is published by docs.json', () => {
    const published = new Set(publishedSlugs());
    const orphans = markdownPages()
      .map((file) => file.replace(/\.mdx?$/, ''))
      .filter((slug) => !published.has(slug));

    expect(
      orphans,
      `These docs are not in any docs.json tab, so they are unreachable from the site navigation: ${orphans.join(', ')}. ` +
        `Add each to the tab it belongs in — Guides, Reference, or Contributing.`,
    ).toEqual([]);
  });

  it('every documented tool argument is one the tool actually accepts', () => {
    // Six argument bugs shipped on this branch before this gate existed: `name` for
    // `recordingName`, `name` for `flowName`, `name` for `baseline`, `testid` for `by`/`value`,
    // top-level `urlContains`/`status` for `mocks`, and `key` for `text`. Every one was written from
    // a neighbouring page or a plausible guess, and every one was caught only by calling the tool.
    //
    // Reticle refuses an unknown parameter rather than applying part of the call, so a reader who
    // copies one gets an error, not a wrong result. That is the good outcome and it still costs a
    // turn — and in a doc read by agents, a bad example is a bad example at scale.
    const allowed = new Map(
      TOOLS.map((tool) => [tool.name, new Set(Object.keys(tool.inputSchema))]),
    );

    /** Length of the object literal starting at `open`, so a scan cannot run into the next example. */
    const objectLength = (text: string, open: number): number => {
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = open; i < text.length; i++) {
        const ch = text[i] ?? '';
        if (inString) {
          if (escaped) escaped = false;
          else if ('\\' === ch) escaped = true;
          else if ('"' === ch) inString = false;
          continue;
        }
        if ('"' === ch) inString = true;
        else if ('{' === ch) depth++;
        else if ('}' === ch) {
          depth--;
          if (0 === depth) return i - open + 1;
        }
      }
      return text.length - open;
    };

    /** Top-level keys of the object literal starting at `open` (index of its `{`). */
    const topLevelKeys = (text: string, open: number): string[] => {
      const keys: string[] = [];
      let depth = 0;
      let inString = false;
      let escaped = false;
      let current = '';
      for (let i = open; i < text.length; i++) {
        const ch = text[i] ?? '';
        if (inString) {
          if (escaped) escaped = false;
          else if ('\\' === ch) escaped = true;
          else if ('"' === ch) {
            inString = false;
          } else if (1 === depth) current += ch;
          continue;
        }
        if ('"' === ch) {
          inString = true;
          if (1 === depth) current = '';
          continue;
        }
        if ('{' === ch || '[' === ch) depth++;
        else if ('}' === ch || ']' === ch) {
          depth--;
          if (0 === depth) break;
        } else if (':' === ch && 1 === depth && '' !== current) {
          keys.push(current);
          current = '';
        }
      }
      return keys;
    };

    const problems: string[] = [];
    for (const file of markdownPages()) {
      const text = readFileSync(join(DOCS, file), 'utf8');
      for (const match of text.matchAll(/"tool"\s*:\s*"(reticle_[a-z0-9_]+)"/g)) {
        const tool = match[1] ?? '';
        const names = allowed.get(tool);
        if (undefined === names) continue; // meta-tools and non-tools are covered by another check
        // Bound the search to the object that CONTAINS this "tool" key. Scanning forward without
        // that bound picks up the next example's args and blames them on this tool.
        const start = match.index ?? 0;
        let objectStart = -1;
        for (let i = start, depth = 0; i >= 0; i--) {
          const ch = text[i] ?? '';
          if ('}' === ch) depth++;
          else if ('{' === ch) {
            if (0 === depth) {
              objectStart = i;
              break;
            }
            depth--;
          }
        }
        if (0 > objectStart) continue;
        const object = text.slice(objectStart, objectStart + objectLength(text, objectStart));
        const argsAt = object.search(/"args"\s*:\s*\{/);
        if (0 > argsAt) continue; // this call takes no args
        const rest = object;
        const open = object.indexOf('{', argsAt + 6);
        for (const key of topLevelKeys(rest, open)) {
          if (!names.has(key)) {
            problems.push(
              `${file}: ${tool} does not accept "${key}" (accepts: ${[...names].join(', ')})`,
            );
          }
        }
      }
    }

    expect(
      problems,
      `These examples pass an argument the tool rejects. Reticle refuses the whole call rather than ` +
        `applying part of it, so a reader who copies one gets "NOT applied, so any result would be ` +
        `an answer to a different question": ${problems.join('; ')}`,
    ).toEqual([]);
  });

  it("a tool page's first example is a call that tool would accept", () => {
    // The `{ tool, args }` check above cannot see the direct form these pages use, where the
    // arguments stand alone under a heading naming the tool. The convention that makes it checkable:
    // in `tools-<x>.mdx`, the FIRST json block is the request. Every later block is a response.
    //
    // Without this, a typo in the headline example of a tool's own page is invisible — and that is
    // the example most likely to be copied.
    const allowed = new Map(
      TOOLS.map((tool) => [tool.name, new Set(Object.keys(tool.inputSchema))]),
    );

    const problems: string[] = [];
    for (const file of markdownPages()) {
      if (!file.startsWith('tools-') || !file.endsWith('.mdx')) continue;
      const text = readFileSync(join(DOCS, file), 'utf8');

      // The tool this page documents, taken from its frontmatter title.
      const title = /^title:\s*(.+)$/m.exec(text)?.[1] ?? '';
      const named = [...title.matchAll(/reticle_[a-z0-9_]+/g)].map((m) => m[0]);
      // Pages covering more than one tool (or none) have no single subject to validate against.
      if (1 !== named.length) continue;
      const names = allowed.get(named[0] ?? '');
      if (undefined === names) continue;

      const block = /```json\n([\s\S]*?)```/.exec(text)?.[1] ?? '';
      let parsed: unknown;
      try {
        parsed = JSON.parse(block);
      } catch {
        continue; // multi-call or elided blocks are not a single request to check
      }
      if (null === parsed || 'object' !== typeof parsed || Array.isArray(parsed)) continue;

      for (const key of Object.keys(parsed)) {
        if (!names.has(key)) {
          problems.push(
            `${file}: the first example passes "${key}", which ${named[0] ?? ''} does not accept ` +
              `(accepts: ${[...names].join(', ')})`,
          );
        }
      }
    }

    expect(
      problems,
      `The headline example on a tool's own page is the one most likely to be copied, so it has to ` +
        `be a call that tool would accept: ${problems.join('; ')}`,
    ).toEqual([]);
  });

  it('the logo and favicon are readable against the theme they render on', () => {
    // Mintlify renders `logo.light` in LIGHT mode — the served HTML puts it in `block dark:hidden`.
    // Its own schema says the opposite ("the light version of the logo used in dark mode"), and
    // trusting that description shipped a white wordmark onto a white background and a black one onto
    // a dark background. Both were invisible, and nothing failed.
    //
    // So: the file behind `light` must be DARK ink, and the file behind `dark` must be LIGHT ink.
    const config: unknown = JSON.parse(readFileSync(join(DOCS, 'docs.json'), 'utf8'));
    const assets = config as { logo?: Record<string, string>; favicon?: Record<string, string> };

    /** Mean brightness of the fills in an SVG, 0 (black) to 255 (white). */
    const inkBrightness = (file: string): number | null => {
      const fills = readFileSync(join(DOCS, file), 'utf8').match(/fill="#([0-9A-Fa-f]{6})"/g) ?? [];
      const values = fills
        .map((fill) => /#([0-9A-Fa-f]{6})/.exec(fill)?.[1] ?? '')
        .filter((hex) => '' !== hex)
        .map((hex) => {
          const n = parseInt(hex, 16);
          return ((n >> 16) + ((n >> 8) & 0xff) + (n & 0xff)) / 3;
        });
      return 0 === values.length ? null : values.reduce((a, b) => a + b, 0) / values.length;
    };

    const problems: string[] = [];
    for (const [kind, pair] of [
      ['logo', assets.logo],
      ['favicon', assets.favicon],
    ] as const) {
      if (undefined === pair) continue;
      for (const [mode, expectation] of [
        ['light', 'dark ink for a light background'],
        ['dark', 'light ink for a dark background'],
      ] as const) {
        const file = pair[mode];
        if (undefined === file) continue;
        const brightness = inkBrightness(file);
        if (null === brightness) continue; // no explicit fills to judge
        const tooLight = 'light' === mode && brightness > 128;
        const tooDark = 'dark' === mode && brightness < 128;
        if (tooLight || tooDark) {
          problems.push(
            `${kind}.${mode} is ${file} with ink brightness ${Math.round(brightness)} — ${mode} ` +
              `mode needs ${expectation}, so this renders invisible`,
          );
        }
      }
    }

    expect(
      problems,
      `A logo the same colour as the page behind it is not a rendering bug anyone notices in a diff: ` +
        `${problems.join('; ')}`,
    ).toEqual([]);
  });

  it('no page contains markup MDX will refuse to build', () => {
    // Two pages 404'd on the deployed site while passing every check here: they existed, were in the
    // nav, had frontmatter, and their links resolved. Mintlify compiles markdown as MDX, so `<1s` in
    // a table cell is read as a JSX tag and `{action:"review"}` as a JS expression. The page fails to
    // build and simply is not there.
    //
    // Nothing local caught it because the file is perfectly good markdown. Only fetching the built
    // site did. These are the two shapes that actually broke.
    const HAZARDS: { pattern: RegExp; what: string }[] = [
      {
        pattern: /<[0-9]/,
        what: 'a bare `<` before a digit (MDX reads it as a tag) — wrap it in backticks',
      },
      {
        pattern: /\]\([^)]*[{}][^)]*\)/,
        what: 'a link whose URL contains { or } (MDX reads it as an expression)',
      },
      { pattern: /\]\([^)\s]*\s[^)]*\)/, what: 'a link whose URL contains a space' },
    ];

    const problems: string[] = [];
    for (const file of markdownPages()) {
      const source = readFileSync(join(DOCS, file), 'utf8');
      // Fenced and inline code are safe: MDX does not parse inside them.
      const prose = source.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
      for (const line of prose.split('\n')) {
        for (const { pattern, what } of HAZARDS) {
          if (pattern.test(line)) problems.push(`${file}: ${what} — ${line.trim().slice(0, 70)}`);
        }
      }
    }

    expect(
      problems,
      `MDX will not build these, and a page that fails to build is a 404 on the site with nothing ` +
        `failing here: ${problems.join('; ')}`,
    ).toEqual([]);
  });

  it('no page shows a predicate combinator in a shape that does not parse', () => {
    // `{ allOf: [ … ] }` reads perfectly and is rejected by the schema. Reticle refuses the whole
    // call rather than evaluating part of it, so a reader who copies one gets NO verdict, which is
    // strictly worse than a failing one. Eight of these shipped across the docs before a sweep.
    // The correct shape is `{ kind: "allOf", predicates: [ … ] }`.
    const BARE = /(?:"(?:allOf|anyOf)"|\b(?:allOf|anyOf))\s*:\s*\[/;
    // Lines that deliberately show the wrong shape, near a marker saying so.
    const DISCLAIMER = /WRONG|does not parse|do(?:es)? not parse|neither does/i;

    const offenders: string[] = [];
    for (const file of markdownPages()) {
      const lines = readFileSync(join(DOCS, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!BARE.test(line)) return;
        if (/"?kind"?\s*:\s*"(?:allOf|anyOf)"[\s\S]*?"?predicates"?\s*:/.test(line)) return;
        const context = lines.slice(Math.max(0, i - 4), i + 2).join('\n');
        if (DISCLAIMER.test(context)) return;
        offenders.push(`${file}:${String(i + 1)}`);
      });
    }

    expect(
      offenders,
      `A combinator needs its own kind and a \`predicates\` array: ` +
        `{ kind: "allOf", predicates: [ … ] }. The bare form does not parse, and Reticle returns no ` +
        `verdict at all rather than a failing one: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every reticle_* tool the docs name still exists in the source', () => {
    // A tool rename once left four e2e specs dead across a whole framework and nothing caught it.
    // The docs are the same shape of victim: they name 50-odd tools, and a rename turns each mention
    // into a lie that renders perfectly. Nothing throws, no test reddens, and an agent following the
    // page calls a tool that is not there.
    const TOOL = /\breticle_[a-z0-9_]+\b/g;

    const sourceNames = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) {
          for (const name of readFileSync(full, 'utf8').match(TOOL) ?? []) sourceNames.add(name);
        }
      }
    };
    walk(join(REPO, 'packages', 'server', 'src'));
    walk(join(REPO, 'packages', 'core', 'src'));

    const unknown: string[] = [];
    for (const file of markdownPages()) {
      const mentioned = new Set(readFileSync(join(DOCS, file), 'utf8').match(TOOL) ?? []);
      for (const name of mentioned) {
        if (!sourceNames.has(name)) unknown.push(`${file} -> ${name}`);
      }
    }

    expect(
      unknown,
      `These pages name a reticle_* tool that does not exist in the source. Either the tool was ` +
        `renamed and the docs were not, or the page has a typo — both render perfectly and both send ` +
        `an agent to call something that is not there: ${unknown.join('; ')}`,
    ).toEqual([]);
  });

  it('MDX components appear only in .mdx pages', () => {
    // Whether Mintlify renders JSX inside a plain `.md` file is not something this repo has
    // verified, and the failure mode if it does not is silent: the component renders as literal
    // text in the middle of a paragraph. Keep components where they are known to work.
    const COMPONENT =
      /<(Note|Tip|Warning|Info|Card|CardGroup|Columns|Accordion|AccordionGroup|Steps|Step|Frame|Tabs|Tab)\b/;
    const offenders = markdownPages()
      .filter((file) => file.endsWith('.md'))
      .filter((file) => COMPONENT.test(readFileSync(join(DOCS, file), 'utf8')));

    expect(
      offenders,
      `These .md pages use MDX components. Either rename the page to .mdx, or use plain markdown ` +
        `(a blockquote reads fine and cannot fail): ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no frontmatter value contains an unquoted colon', () => {
    // This one took two pages off the live site while every check in this repo stayed green.
    // A plain (unquoted, unbracketed) YAML scalar cannot contain `: `, so a description reading
    //   description: Diagnose the setup in one command: Chromium, daemon, ...
    // is a parse error. Mintlify does not build the page and serves a 404, while the file is
    // present, listed in docs.json, and indexed in README.md. Nothing above can see it, because
    // in the repository everything is consistent; the damage is only on the deployed site.
    const offenders: string[] = [];
    for (const file of markdownPages()) {
      const text = readFileSync(join(DOCS, file), 'utf8');
      if (!text.startsWith('---\n')) continue;
      const end = text.indexOf('\n---', 4);
      if (-1 === end) continue;
      for (const line of text.slice(4, end).split('\n')) {
        const match = /^([A-Za-z][\w-]*):\s+(.*)$/.exec(line);
        if (null === match) continue;
        const key = match[1];
        const value = match[2];
        if (undefined === value || '' === value) continue;
        // Already a quoted, flow or block scalar: YAML handles the colon fine.
        if ('\'"[{|>'.includes(value.slice(0, 1))) continue;
        if (value.includes(': ')) offenders.push(`${file}: ${key}`);
      }
    }

    expect(
      offenders,
      `These frontmatter values contain an unquoted colon, which is invalid YAML and 404s the page ` +
        `on the published site while everything in the repo still looks correct. Wrap the value in ` +
        `single quotes: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no page uses an em dash', () => {
    // House style for the published docs. Nothing else enforces it, and a rule enforced by review
    // is a rule that is wrong within a month. Use a comma, a colon, a full stop, or a rewrite.
    const offenders = markdownPages()
      .map((file) => ({
        file,
        count: (readFileSync(join(DOCS, file), 'utf8').match(/—/g) ?? []).length,
      }))
      .filter((row) => row.count > 0)
      .map((row) => `${row.file} (${row.count})`);

    expect(
      offenders,
      `These pages use em dashes. Replace each with a comma, a colon, a full stop, or a rewrite: ` +
        `${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('no page draws a diagram out of box-drawing characters', () => {
    // Box-drawing and arrow glyphs. ASCII diagrams were ruled out for the published docs: they
    // wrap badly on narrow screens, are unreadable to a screen reader, and read as unfinished.
    // Mermaid renders natively on Mintlify and is the replacement.
    const ART = /[─-╿▲▼◄►]/;
    const offenders = markdownPages().filter((file) =>
      ART.test(readFileSync(join(DOCS, file), 'utf8')),
    );

    expect(
      offenders,
      `These pages contain box-drawing characters. Use a \`\`\`mermaid block instead — it renders as a ` +
        `real diagram: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('every internal link resolves to a page or an image that exists', () => {
    const slugs = new Set(markdownPages().map((file) => file.replace(/\.mdx?$/, '')));
    const broken: string[] = [];

    for (const file of markdownPages()) {
      const source = readFileSync(join(DOCS, file), 'utf8');
      const links = [
        ...source.matchAll(/href="(\/[^"#]*)"/g),
        ...source.matchAll(/\]\((\/[^)#]*)\)/g),
      ].map((match) => match[1] ?? '');

      for (const link of new Set(links)) {
        if (link.startsWith('/images/')) {
          if (!existsSync(join(DOCS, link))) broken.push(`${file} -> ${link} (missing image)`);
          continue;
        }
        const slug = link.replace(/^\/|\/$/g, '');
        if ('' !== slug && !slugs.has(slug)) broken.push(`${file} -> ${link} (no such page)`);
      }
    }

    expect(
      broken,
      `These links 404 on the published site. A dead link in docs is silent — nothing throws, the ` +
        `page renders, and the reader hits a wall: ${broken.join('; ')}`,
    ).toEqual([]);
  });

  it('every published page carries frontmatter and no duplicate H1', () => {
    const broken = publishedSlugs()
      .map((slug) => ({ slug, file: pageFile(slug) }))
      .filter((page): page is { slug: string; file: string } => null !== page.file)
      .map(({ slug, file }) => {
        // Windows checkouts carry CRLF, which makes every `^---$` and `startsWith('---\n')`
        // below miss and reports all 24 pages as unfrontmattered. Normalise before parsing.
        const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
        const [, frontmatter = '', body = ''] = source.split(/^---$/m);
        if (!source.startsWith('---\n')) return `${slug}: no frontmatter block`;
        if (!/^title:\s*\S/m.test(frontmatter)) return `${slug}: frontmatter has no title`;
        if (!/^description:\s*\S/m.test(frontmatter))
          return `${slug}: frontmatter has no description`;
        // A `# ` inside a fenced block is a shell comment, not a heading.
        const prose = body.replace(/^```[\s\S]*?^```/gm, '');
        if (/^# /m.test(prose)) return `${slug}: body still has an H1, which renders twice`;
        return null;
      })
      .filter((problem): problem is string => null !== problem);

    expect(
      broken,
      `Mintlify renders the frontmatter title as the page heading and the description as the search ` +
        `snippet, so a page without them ships with its slug as its name: ${broken.join('; ')}`,
    ).toEqual([]);
  });
});
