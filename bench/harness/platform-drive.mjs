// Drive a connected app with NOTHING but a platform key, and print what drove it.
//
// The one claim that neither repository's tests can make on its own: somebody who has never held a
// model API key ran `reticle link`, got an `rk_live_` key, and verified their own app. The daemon
// is started here with every provider key deliberately BLANK, so a drive that works cannot be
// working for some other reason.
//
// Prints one JSON object on the last line, which is what the caller reads. Driven by
// reticle-cloud's scripts/harness-sync-check.mjs; runnable on its own for a quick manual check:
//
//   RETICLE_CLOUD_URL=... RETICLE_API_KEY=rk_live_... node bench/harness/platform-drive.mjs
//
import { execFileSync } from 'node:child_process';
import { McpStdioClient } from './mcp-client.mjs';

const REPO = process.env.RETICLE_REPO ?? process.cwd();
const APP_URL = process.env.APP_URL ?? 'http://localhost:5273/';
/**
 * The daemon's port, which is NOT free to choose.
 *
 * A page's SDK dials the port it was BUILT with — the bundler baked it in when the dev server
 * started — so a daemon anywhere else is a daemon that page will never connect to. Starting one on
 * a "clean" port of our own produced exactly that: a daemon that had never seen a session, and an
 * error about project scope that sent the reader looking in the wrong place entirely.
 *
 * Defaults to Reticle's own default, which is what an app that was never told otherwise dials.
 */
const PORT = process.env.RETICLE_PORT ?? '4400';
const MAX_STEPS = process.env.PLATFORM_DRIVE_STEPS ?? '14';

const cloudUrl = process.env.RETICLE_CLOUD_URL;
const cloudKey = process.env.RETICLE_API_KEY ?? process.env.RETICLE_CLOUD_KEY;
if (cloudUrl === undefined || cloudKey === undefined) {
  console.log(
    JSON.stringify({
      status: 'NOT MEASURED',
      reason: 'RETICLE_CLOUD_URL and RETICLE_API_KEY are required',
    }),
  );
  process.exit(0);
}

/**
 * Clear the port first.
 *
 * `reticle mcp --port N` ATTACHES to a daemon already holding N, and a daemon reads its driver and
 * its keys from the environment once, at startup. Reusing one would mean this check silently
 * measured whatever the LAST daemon was configured with — which, for a check whose entire point is
 * that no provider key is present, would be the one way to get a green that means nothing.
 *
 * `-sTCP:LISTEN` is load-bearing: without it this also matches `reticle mcp` proxies, including an
 * editor's, and killing those is the commonest cause of a "Reticle MCP disconnected" that has
 * nothing to do with Reticle.
 */
try {
  const pids = execFileSync('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  }).trim();
  for (const pid of pids.split('\n').filter(Boolean)) {
    try {
      process.kill(Number(pid));
    } catch {
      /* already gone */
    }
  }
} catch {
  /* lsof exits non-zero when nothing matches, which is the ordinary case */
}

const client = new McpStdioClient(
  'node',
  [`${REPO}/server/dist/command/cli.js`, 'mcp', '--port', PORT, '--drive', APP_URL],
  {
    RETICLE_PORT: PORT,
    RETICLE_HARNESS_MAX_STEPS: MAX_STEPS,
    RETICLE_CLOUD_URL: cloudUrl,
    RETICLE_API_KEY: cloudKey,
    // Said out loud rather than merely omitted: the claim is that these are not needed, and an
    // inherited one from the caller's shell would prove the opposite of what this measures.
    JEV_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
  },
);

try {
  await client.start();

  /**
   * WAIT for a session, rather than sleeping and hoping.
   *
   * A fixed pause is a guess about somebody else's machine. Four seconds was plenty for the small
   * fixture this was first written against and not nearly enough for a real dashboard that builds
   * its design system from source: the browser opened, the page loaded, the SDK connected — and the
   * explore had already run and failed, against a daemon that had genuinely never seen a session.
   * The error then blamed project scope, which sent the reader somewhere else entirely.
   */
  const deadline = Date.now() + 90_000;
  let sessionId;
  while (Date.now() < deadline) {
    const listed = await client
      .callTool('reticle_session', { action: 'list' }, 15_000)
      .catch(() => null);
    const text = listed?.result?.content?.[0]?.text ?? listed?.content?.[0]?.text ?? '{}';
    const sessions = JSON.parse(text).sessions ?? [];
    const match = sessions.find((session) =>
      String(session.url ?? '').startsWith(APP_URL.replace(/\/$/, '')),
    );
    if (match !== undefined) {
      sessionId = match.sessionId;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (sessionId === undefined)
    throw new Error(`no session on ${APP_URL} after 90s — the app never connected to this daemon`);
  /*
   * The session is named EXPLICITLY, and that is not belt-and-braces.
   *
   * A daemon is scoped to the project of the directory it was started in, and this one is started
   * by a check that lives in the platform's repository — so it scoped itself to `console-…` and
   * refused to drive sessions belonging to `razorpay-merchant-dashboard-…`, which were right there
   * and connected. Naming the session this check just watched arrive is the honest fix: it drives
   * the app it came to drive, rather than whichever project the caller happened to run from.
   */
  const raw = await client.callTool(
    'reticle_verify',
    { action: 'explore', persona: 'Open the main sections of this dashboard.', sessionId },
    240_000,
  );
  const text = raw?.result?.content?.[0]?.text ?? raw?.content?.[0]?.text;
  if (text === undefined) throw new Error(`no tool output: ${JSON.stringify(raw).slice(0, 300)}`);
  console.log(text.trim());
} catch (error) {
  const reason = String(error?.message ?? error);
  // The one failure worth translating, because Reticle cannot see the cause from inside: the page
  // dials the port its bundle was built with, so "never seen a session" usually means this daemon
  // is on the wrong one rather than that anything is broken.
  const portHint = reason.includes('never seen one')
    ? ` The app at ${APP_URL} dials the port baked into its bundle; this daemon is on ${PORT}. If they differ, no session can ever connect.`
    : '';
  console.log(JSON.stringify({ status: 'FAILED', reason: `${reason}${portHint}` }));
} finally {
  await client.stop().catch(() => {});
}
