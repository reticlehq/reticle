/**
 * Telling a Python (or Ruby, or Go, or PHP) developer why Reticle cannot wire their app.
 *
 * `reticle init` answered "No package.json found here, and no app directory beneath it either",
 * which reads as *you are in the wrong directory* — so an agent on a Streamlit app went looking for
 * a directory that does not exist, then went looking for a standalone browser bundle to inject by
 * hand, and only worked out the real answer several steps later.
 *
 * The real answer is not about directories at all: Reticle's SDK has to be imported by the app's own
 * JS build, and a server-rendered Python app has no JS build to import it from. That is a property
 * of the project, it is knowable from one look at the filesystem, and saying it plainly costs the
 * reader nothing while the directory message costs them the whole investigation.
 *
 * Deliberately a hint, not a refusal: a Django or Rails app with a `frontend/` package.json is a
 * perfectly ordinary Reticle install, and this only ever speaks when there is no package.json to be
 * found anywhere.
 */

/** Marker files that identify an ecosystem, and what to call it. */
const ECOSYSTEM_MARKERS: readonly (readonly [string, string])[] = [
  ['requirements.txt', 'Python'],
  ['pyproject.toml', 'Python'],
  ['Pipfile', 'Python'],
  ['setup.py', 'Python'],
  ['manage.py', 'Python (Django)'],
  ['Gemfile', 'Ruby'],
  ['go.mod', 'Go'],
  ['composer.json', 'PHP'],
  ['Cargo.toml', 'Rust'],
  ['pom.xml', 'Java'],
  ['build.gradle', 'Java'],
  ['mix.exs', 'Elixir'],
  // Not like the others. Every ecosystem above can grow a JS front end that Reticle instruments
  // perfectly well, so their message ends with a lead. Flutter web paints into a canvas, and there
  // is no DOM behind it at any path, so the honest answer is a named refusal.
  ['pubspec.yaml', 'Flutter'],
];

/** The one ecosystem where no directory, front end or flag could ever help. */
const FLUTTER = 'Flutter';

const STREAMLIT_DEPENDENCY_FILES = ['requirements.txt', 'pyproject.toml', 'Pipfile'];
const STREAMLIT_DEPENDENCY = /(?:^|[\n,"'])\s*streamlit(?:\[[^\]\n]*\])?\s*(?:[<>=!~;]|$)/im;
const STREAMLIT_IMPORT =
  /(?:^|\n)\s*(?:import\s+streamlit(?:\s+as\s+\w+)?|from\s+streamlit(?:\.|\s+import))/m;

/** Whether the no-package project is specifically a Streamlit app. */
export function detectStreamlitProject(
  readFile: (file: string) => string | null,
  rootFiles: readonly string[],
): boolean {
  for (const file of STREAMLIT_DEPENDENCY_FILES) {
    const source = readFile(file);
    if (null !== source && STREAMLIT_DEPENDENCY.test(source)) return true;
  }
  for (const file of rootFiles.filter((name) => name.endsWith('.py'))) {
    const source = readFile(file);
    if (null !== source && STREAMLIT_IMPORT.test(source)) return true;
  }
  return false;
}

/** The Streamlit-specific explanation printed immediately before its generated helper. */
export function streamlitSetupMessage(): string {
  return (
    'This is a Streamlit project. Streamlit owns the top-level HTML document, so there is no ' +
    'served template for the generic script tag, and scripts passed to `st.markdown` do not run. ' +
    'Use Streamlit 1.63 or newer and add the `st.html` helper below during development. It runs ' +
    'Reticle in the app document and guards against duplicate connections across reruns.'
  );
}

/**
 * Whether the no-package project is specifically a Django app.
 *
 * `manage.py` is the marker every Django project has and nothing else does, and it is already in
 * ECOSYSTEM_MARKERS as `Python (Django)` — this asks the narrower question so the setup message can
 * be Django's rather than Python's in general.
 *
 * Confirmed by `settings.py` alongside it where possible, because a bare `manage.py` in a repo root
 * that also holds the real app deeper down should not claim more than it knows.
 */
export function detectDjangoProject(
  exists: (file: string) => boolean,
  rootDirectories: readonly string[] = [],
): boolean {
  if (!exists('manage.py')) return false;
  if (exists('settings.py')) return true;
  return rootDirectories.some((dir) => exists(`${dir}/settings.py`));
}

/** The Django-specific explanation printed immediately before its generated middleware. */
export function djangoSetupMessage(): string {
  return (
    'This is a Django project. Django renders templates server-side, so there is no JS build to ' +
    'import the SDK from and no single template to paste a script tag into — an app has many, and ' +
    'may not have a base one. The middleware below is the Django-shaped answer: it runs for every ' +
    'page, injects Reticle into HTML responses only, and is guarded on `settings.DEBUG` so it can ' +
    'never reach production. Add it to MIDDLEWARE, start your server as usual, and the page will ' +
    'dial the daemon on load. ' +
    'If this project ALSO has a JS front end with its own package.json, running `reticle init` ' +
    'there instead gives you source mapping and framework state as well: point at it with ' +
    '`--app <dir>`.'
  );
}

/** The ecosystem this directory looks like, or undefined when nothing says. */
export function detectNonJsEcosystem(exists: (file: string) => boolean): string | undefined {
  for (const [marker, name] of ECOSYSTEM_MARKERS) {
    if (exists(marker)) return name;
  }
  return undefined;
}

/**
 * What `init` should say when there is no package.json.
 *
 * Two genuinely different situations behind one old sentence: a JS developer standing in the wrong
 * directory, and a developer whose project is not JavaScript at all. The first needs a path; the
 * second needs to know that no path exists and why.
 */
export function noPackageJsonMessage(exists: (file: string) => boolean): string {
  const ecosystem = detectNonJsEcosystem(exists);
  if (ecosystem === undefined) {
    return (
      'No package.json found here, and no app directory beneath it either. Run `reticle init` from ' +
      "your app's directory, or from a repo root that contains it."
    );
  }
  if (ecosystem === FLUTTER) {
    // An agent on a Flutter workspace asked us to "support Flutter, or clearly identify it as
    // unsupported during init". The second is the truthful one, and saying it by name in one line
    // is the difference between an agent that stops and an agent that spends an hour looking for
    // the package.json we told it was missing.
    return (
      'This is a Flutter project. Reticle cannot instrument it, and no directory or flag will ' +
      'change that: Reticle reads the DOM of a running page, and Flutter web paints its entire UI ' +
      'into a single canvas element with no DOM behind it. Nothing here is missing or misconfigured. ' +
      'If this repo also contains an ordinary web app with its own package.json, run `reticle init` ' +
      'inside that directory instead.'
    );
  }
  return (
    `This looks like a ${ecosystem} project, and there is no package.json here or in any app ` +
    'directory beneath it. That is not a blocker: Reticle needs its SDK loaded by the page, not ' +
    'built by npm, and a page with no build step can load it from a URL. ' +
    // The old message ended at "there is no directory you could run this from that would change
    // that", which read as a refusal and was acted on as one — agents went looking for a bundler,
    // or for a standalone build to inject by hand, or gave up and used a different tool. The
    // capability was there the whole time; only the sentence was missing. Proven end to end on a
    // page served by `python3 -m http.server` before this line was written.
    'Add the script-tag snippet below to a template you only serve in development, then reload the ' +
    'page. ' +
    'If this project ALSO has a JS front end (a `frontend/`, `client/` or `assets/` directory with ' +
    'its own package.json), running `reticle init` there instead gives you source mapping and ' +
    'framework state as well: point at it with `--app <dir>`.'
  );
}
