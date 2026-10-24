/**
 * A CI persona expects `reticle gate` to be the one command that fails the build on a regression.
 * It exited 2 on a project with no saved flows and said nothing about a regression the dashboard
 * already knew, while `reticle runs regression` was the command that exited 3.
 */
import { describe, expect, it } from 'vitest';
import {
  GateExit,
  MSG_GATE_NO_FLOWS,
  gateExitWith,
  msgGateRefused,
  msgGateRegression,
} from './gate-exit.js';
import { renderHelp } from '../cli-usage.js';

describe('the gate and a regression the platform knows about', () => {
  it('fails with the exit code `reticle runs regression` uses, whatever the local answer', () => {
    expect(gateExitWith(GateExit.PASS, 1)).toBe(GateExit.REGRESSION);
    expect(gateExitWith(GateExit.NOTHING_TO_CHECK, 2)).toBe(GateExit.REGRESSION);
    expect(gateExitWith(GateExit.FAIL, 1)).toBe(GateExit.REGRESSION);
    expect(GateExit.REGRESSION).toBe(3);
  });

  it('leaves the local answer alone when nothing regressed, or nothing could be asked', () => {
    expect(gateExitWith(GateExit.PASS, 0)).toBe(GateExit.PASS);
    expect(gateExitWith(GateExit.NOTHING_TO_CHECK, undefined)).toBe(GateExit.NOTHING_TO_CHECK);
  });

  it('says what to do when there are no saved flows, and that the change did not fail', () => {
    expect(MSG_GATE_NO_FLOWS).toContain('not a failure of this change');
    expect(MSG_GATE_NO_FLOWS).toContain('reticle verify');
  });
});

/*
 * From a CI drive: with the project's key revoked, the gate passed and said nothing — the platform's
 * regression report it was linked to read was simply missing, and the only trace was a log line. A
 * gate that cannot ask the platform it is linked to fails closed, and says why.
 */
describe('a gate whose platform refused its key', () => {
  it('fails instead of passing, and keeps a worse local answer', () => {
    expect(gateExitWith(GateExit.PASS, undefined, true)).toBe(GateExit.FAIL);
    expect(gateExitWith(GateExit.NOTHING_TO_CHECK, undefined, true)).toBe(
      GateExit.NOTHING_TO_CHECK,
    );
    expect(gateExitWith(GateExit.PASS, undefined, false)).toBe(GateExit.PASS);
  });

  it('says the key was refused, and that the build did not pass because of it', () => {
    const said = msgGateRefused('the platform refused this API key (401): it was revoked');
    expect(said).toContain('refused this API key');
    expect(said).toContain('fails closed');
  });

  // Persona drive: "…set RETICLE_API_KEY to it.. The gate could not ask…".
  it('says it in sentences, one period each', () => {
    expect(msgGateRefused('mint a new key and set RETICLE_API_KEY to it.')).not.toContain('..');
  });
});

/** Exit 3 outside a hook printed only JSON that still said "nothing was checked". */
describe('a regression the gate fails on', () => {
  it('is named in one plain line', () => {
    expect(
      msgGateRegression([
        { flowName: 'checkout-pay', previousStatus: 'pass', currentStatus: 'fail' },
      ]),
    ).toBe(
      'Reticle gate: regression — checkout-pay (pass → fail) passed before and fails now on the platform. See `reticle runs regression`.',
    );
  });
});

/**
 * `login`, `link` and `push --help` named no sign-in without a browser. Email sign-in is gone, so
 * the help names the key instead, and never the removed `--email` path.
 */
describe('the help a person reads before signing in without a browser', () => {
  it('names the key for CI, not the removed email sign-in, and serve says it returns', () => {
    const connect = renderHelp('login', new Map([['login', 'connect']]));
    expect(connect).toContain('RETICLE_API_KEY');
    expect(connect).not.toContain('--email');
    expect(renderHelp('serve')).toContain('in the background');
    expect(renderHelp('sync')).toContain('`reticle push` is the same command');
  });
});
