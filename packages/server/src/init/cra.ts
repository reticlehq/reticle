/**
 * Wiring Reticle into a Create React App project.
 *
 * CRA had no automated path: init reported `⚠ Connect snippet → index.html`, a target that cannot
 * work. CRA's `public/index.html` is a static template the bundler never processes for modules, so a
 * bare import in it resolves to nothing. `src/index.tsx` is what gets bundled, and that is where the
 * connect has to arrive.
 *
 * The token is the second half of the problem. Every other stack has somewhere to inline it —
 * Vite defines `__RETICLE_TOKEN__`, the Astro and HTML snippets read the file in Node. `src/index.tsx`
 * is browser code inside a bundler that inlines exactly one thing: environment variables prefixed
 * `REACT_APP_`. So it travels through `.env.development.local`, which is CRA's own documented
 * mechanism and is gitignored by CRA's own template.
 */

/** The line added to `src/index.tsx`. Side-effect import: the module guards itself on NODE_ENV. */
export const CRA_DEV_MODULE_IMPORT = "import './reticle-dev';";
export const CRA_DEV_MODULE_PATH = 'src/reticle-dev.ts';
export const CRA_ENV_PATH = '.env.development.local';
export const TOKEN_VAR = 'REACT_APP_RETICLE_TOKEN';

/**
 * What the app itself says when the token is not there.
 *
 * The token is a per-machine secret and CRA's own template gitignores the file it lives in, so it
 * CANNOT travel with the repo — that part is correct and must stay. What was wrong is that it failed
 * silently: a teammate clones, runs `npm start`, and the app connects with an empty token, so the
 * only signal is the bridge's generic `authentication failed` in a console nobody had open. Naming
 * the variable, the gitignored file and the one command that fixes it turns a dead app into a
 * one-line repair. Every other stack reads the token in Node at dev-server start (the Vite plugin,
 * withReticle); CRA has no such hook without ejecting, so this message is the fix.
 */
export const CRA_TOKEN_MISSING_NOTE =
  `${TOKEN_VAR} is not set, so Reticle cannot pair with the daemon. ` +
  `The pairing token is per-machine and ${CRA_ENV_PATH} is gitignored by CRA's template, ` +
  'so it does not survive a clone. Run `npx reticle init` in this project to write it for this machine.';

/**
 * Said as its own NOTICE line, beside the write — not inside it.
 *
 * The caveat has always been in the write step's `detail`, and the write step renders `[✓]`. But
 * `SKILL.md` tells whoever reads the report: *"If every line is `✓`, `·` or `–`, skip to Step 4 and
 * validate."* So the one fact that makes this install conditional sat in the one place the reading
 * protocol says to ignore — which is exactly how it was reported to us as "4 OK marks and no
 * warning". The words were on screen; the reader was following instructions.
 *
 * It cannot simply be promoted: `run.ts` only writes steps whose status is APPLY, so demoting the
 * token step to NOTICE would stop it writing the token and break the install outright.
 */
export const CRA_TOKEN_PER_MACHINE_NOTICE =
  `${CRA_ENV_PATH} is in CRA's own .gitignore, so the token just written does not travel. ` +
  'It works on THIS machine and nowhere else: a teammate cloning the repo, CI, or a container ' +
  'gets an app that boots, never pairs, and reports it only in the browser console. ' +
  'Each developer runs `npx reticle init` once locally.';

/** Add the import after the last existing one, or null when it is already present. */
export function craImportPatch(source: string): string | null {
  if (source.includes(CRA_DEV_MODULE_IMPORT)) return null;
  const lines = source.split('\n');
  // After the LAST import: React's own imports must still run first, and a side-effect import placed
  // above them would connect before the app exists.
  let lastImport = -1;
  for (const [index, line] of lines.entries()) {
    if (/^\s*import\s/.test(line)) lastImport = index;
  }
  lines.splice(lastImport + 1, 0, CRA_DEV_MODULE_IMPORT);
  return lines.join('\n');
}

/** Set the token variable, or null when nothing needs to change. */
export function craEnvPatch(existing: string | null, token: string): string | null {
  if ('' === token) return null;
  const line = `${TOKEN_VAR}=${token}`;
  if (null === existing || '' === existing.trim()) return `${line}\n`;
  if (existing.includes(line)) return null;
  // Replace rather than append: two assignments of one variable is a silent coin flip on which wins.
  if (new RegExp(`^${TOKEN_VAR}=`, 'm').test(existing)) {
    return existing.replace(new RegExp(`^${TOKEN_VAR}=.*$`, 'm'), line);
  }
  return `${existing.endsWith('\n') ? existing : `${existing}\n`}${line}\n`;
}

/** The dev-only connect module imported from `src/index.tsx`. */
export function craDevModuleFile(port: number | undefined, projectId?: string): string {
  const fields: string[] = [];
  if (port !== undefined) fields.push(`url: 'ws://127.0.0.1:${String(port)}/reticle'`);
  if (projectId !== undefined && projectId.length > 0) fields.push(`projectId: '${projectId}'`);
  const inline = fields.length > 0 ? `${fields.join(', ')}, ` : '';
  return `// Dev-only: connect Reticle. Imported for its side effect from src/index.tsx.
//
// CRA's public/index.html is a static template the bundler never processes for modules, so the
// connect cannot live there. The pairing token arrives through REACT_APP_RETICLE_TOKEN because
// REACT_APP_* is the only thing CRA inlines into browser code.
if (process.env.NODE_ENV === 'development') {
  void import('@reticlehq/react').then(({ reticle, install }) => {
    install();
    const token = process.env.${TOKEN_VAR} ?? '';
    // Loud on purpose: without this the only symptom is the bridge's generic auth failure.
    if (token.length === 0) console.error(${JSON.stringify(`[reticle] ${CRA_TOKEN_MISSING_NOTE}`)});
    // Still attempt it — a bridge running without a token pairs fine.
    reticle.connect({ ${inline}...(token.length > 0 ? { token } : {}) });
  });
}

export {};
`;
}
