/**
 * `doctor` could not say the one thing that is wrong most often.
 *
 * It reads `.reticle.json` for the PORT, so it already knew whether the file was there — and it
 * never mentioned it. In a project where `init` has not run, the checklist came out looking clean:
 * node fine, chromium fine, a daemon that starts on demand, a bridge port. Every line true, and the
 * app carrying no SDK went unremarked, which is the state that produces "the tools are here and
 * nothing verifies".
 *
 * Registering the MCP server and wiring the app are two different halves of the install, and more
 * than one path does the first without the second. This is the line that says which half is missing.
 */

import { describe, expect, it } from 'vitest';
import { projectWiringLine } from './doctor-project-line.js';

describe('the doctor line about this project', () => {
  it('says init has not run here, and names the command', () => {
    const line = projectWiringLine({ projectId: undefined, previouslyConnected: false });
    expect(line).toMatch(/✗/);
    expect(line).toMatch(/init/);
  });

  /**
   * The Vite and Babel plugins wire an app without writing a config file, so an app that has
   * connected here is wired whatever the file says. Sending that project to `init` would be the same
   * wrong answer pointing the other way, and `init` is the one action that can overwrite a working
   * setup.
   */
  it('does not send a project that has connected back to init', () => {
    const line = projectWiringLine({ projectId: undefined, previouslyConnected: true });
    expect(line).not.toMatch(/init/);
    expect(line).toMatch(/✓/);
  });

  it('reports a wired project as wired', () => {
    const line = projectWiringLine({ projectId: 'app-abc', previouslyConnected: false });
    expect(line).toMatch(/✓/);
    expect(line).toContain('app-abc');
  });

  it('is one line, like every other check beside it', () => {
    for (const facts of [
      { projectId: undefined, previouslyConnected: false },
      { projectId: undefined, previouslyConnected: true },
      { projectId: 'app-abc', previouslyConnected: true },
    ]) {
      expect(projectWiringLine(facts).split('\n')).toHaveLength(1);
    }
  });
});

/**
 * A `.reticle.json` that is PRESENT but unreadable is not the same as one that is absent, and saying
 * so matters more here than it looks. "No .reticle.json here" sends somebody hunting a missing file
 * when what they have is a broken one — and the file being broken is itself the finding, since a
 * corrupt config is how a project ends up talking to the wrong daemon.
 *
 * The remedy is the same command either way, which is exactly why the statement of fact has to carry
 * its weight: it is the only part of the line that tells them what is actually true.
 */
describe('a config that is there but cannot be read', () => {
  it('does not claim the file is missing', () => {
    const line = projectWiringLine({
      projectId: undefined,
      previouslyConnected: false,
      configPresent: true,
    });
    expect(line).not.toMatch(/no \.reticle\.json/i);
    expect(line).toMatch(/projectId|corrupt|unreadable/i);
    expect(line, 'the remedy is still init').toMatch(/init/);
  });

  it('still says missing when it really is missing', () => {
    const line = projectWiringLine({
      projectId: undefined,
      previouslyConnected: false,
      configPresent: false,
    });
    expect(line).toMatch(/no \.reticle\.json/i);
  });
});
