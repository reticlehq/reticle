import { describe, expect, it } from 'vitest';
import { remainingSteps, type Progress } from './remaining-steps.js';

const at = (p: Partial<Progress>): Progress => ({
  initDone: false,
  devServerUp: false,
  sessionConnected: false,
  flowSaved: false,
  urlSuppliedByCaller: false,
  ...p,
});

describe('picking up where setup stopped', () => {
  it('starts at init when nothing has happened', () => {
    expect(remainingSteps(at({}))[0]).toContain('init');
  });

  // The point of the whole module: a run that got past init must not be told to re-run it.
  it('never tells you to redo a step that already worked', () => {
    const steps = remainingSteps(
      at({ initDone: true, devServerUp: true, devCommand: 'npm run dev' }),
    );
    expect(steps.join(' ')).not.toContain('npx @reticlehq/server@latest init');
    expect(steps[0]).toContain('reticle_session { action: "list" }');
  });

  it('names the dev command when the server is the missing piece', () => {
    expect(remainingSteps(at({ initDone: true, devCommand: 'pnpm dev -p 3100' }))[0]).toContain(
      'pnpm dev -p 3100',
    );
  });

  // Someone who passed --url is already running their server; telling them to start it is noise.
  it('does not tell a caller who supplied a url to start a server', () => {
    const steps = remainingSteps(
      at({ initDone: true, urlSuppliedByCaller: true, url: 'http://localhost:3000/' }),
    );
    expect(steps.join(' ')).not.toContain('Start the dev server');
  });

  it('names the url in the session step when there is one', () => {
    expect(
      remainingSteps(at({ initDone: true, devServerUp: true, url: 'http://localhost:5173/' })).join(
        ' ',
      ),
    ).toContain('http://localhost:5173/');
  });

  /*
   * This used to assert the instruction said `asserted` — check the GRADE of a saved flow, because
   * one that only acts passes even when the feature is broken. Onboarding no longer drives or saves
   * anything, so that instruction is gone and the fallback hands the first run over instead.
   *
   * What replaces it is the same duty one step earlier: a reader here has a connected app and no
   * proof, and must be given a route that WORKS. Both are named because `explore` needs a key, and
   * naming only that one is a dead end on a machine without one.
   */
  it('hands over the first run, naming a route that needs no key and one that does', () => {
    const drive = remainingSteps(
      at({ initDone: true, devServerUp: true, sessionConnected: true }),
    ).join(' ');
    expect(drive).toContain('reticle_act_and_wait');
    expect(drive).toContain('reticle_verify { action: "explore"');
    expect(drive, 'the key requirement must be stated, or explore is a dead end').toContain(
      'ANTHROPIC_API_KEY',
    );
  });

  /*
   * Every one of these lists is printed BECAUSE something did not finish, and none of them asked
   * for a word about it.
   *
   * The ask lives in `init`, which prints it after the file writes and BEFORE the dev server, the
   * page probe and the wait for a session -- i.e. before everything most likely to break. Measured
   * on the cra install-gate cell: the ask is line 27 of the run and `⚠ setup did not finish` is the
   * last thing printed, with the whole runtime stage in between. `git grep -c feedback` over
   * server/src/command/setup returned ZERO before this.
   *
   * So the reader who has just been told what went wrong is the one reader guaranteed to have
   * something worth reporting, and was the one reader never asked.
   */
  it('asks for a word about what went wrong, because this list only prints when it did', () => {
    const steps = remainingSteps(at({ initDone: true, devServerUp: true })).join(' ');
    expect(steps).toContain('feedback --agent --kind');
  });

  it('asks on a run that connected but proved nothing, too', () => {
    // The other incomplete ending. It prints the same fallback, and "connected but NOT verified" is
    // exactly the state somebody gives up in without saying why.
    const steps = remainingSteps(
      at({ initDone: true, devServerUp: true, sessionConnected: true }),
    ).join(' ');
    expect(steps).toContain('feedback --agent --kind');
  });

  it('leaves only the docs pointer when everything succeeded', () => {
    const steps = remainingSteps(
      at({ initDone: true, devServerUp: true, sessionConnected: true, flowSaved: true }),
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]).toContain('docs.reticle.sh');
  });
});
