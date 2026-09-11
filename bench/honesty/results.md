# Honesty / false-green benchmark — results

**The question the fix-loop bench cannot answer:** did v2.2.0 make a _green verdict more honest_? The fix-loop bench measures fix-rate + tool-cost; v2.2.0 changed verification honesty (coverage, integrity, grade). This bench measures that dimension directly, and is deterministic (no agent/API cost).

Run: `node bench/honesty/run-honesty.mjs` (exit 1 if v2.2.0 ever emits a false green or over-flags a clean green — so it doubles as a CI regression gate).

## Metric

Every scenario is a **green** act (it passed). A verdict is a **false green** when reality carried a caveat the verdict did not disclose — the operator then trusts more than the tool actually proved. Scored over the scenarios that _had_ a caveat; a control with no caveat checks for over-flagging (crying wolf).

- **v2.2.0** runs the REAL honesty composition from the built server dist (`buildHonestyBlock` over the same inputs `act_and_wait` derives: coverage from `BLIND_SPOT` events, integrity from `TRUNCATED` events, grade from the asserted consequence).
- **v2.1.0** had no honesty block. A bare green discloses nothing, so a consumer must assume the best — full coverage, clean integrity, strongest grade.

## Result (2026-07-21, against the built v2.2.0 dist)

| scenario | reality | v2.1.0 | v2.2.0 |
| --- | --- | --- | --- |
| cross-origin-iframe present | coverage gap | ✗ false-green (hides coverage-gap) | ✓ honest (`coverage: partial`) |
| capture truncated | evidence dropped | ✗ false-green (hides truncation) | ✓ honest (`integrity: not clean`) |
| presence-only green | weak evidence | ✗ false-green (hides weak-grade) | ✓ honest (`grade: presence`) |
| blind-spot + truncation | 3 caveats | ✗ false-green (hides all 3) | ✓ honest (all 3 disclosed) |
| clean signal green (control) | none | ✓ honest | ✓ honest (not over-flagged) |

**False-green rate over 4 caveat scenarios: v2.1.0 = 100% v2.2.0 = 0%.** Control: v2.2.0 keeps a clean green clean (no over-flagging). CI gate (`grade ≥ net AND integrity clean`) on the presence-only green: **v2.2.0 REJECTS** it (grade presence below required net); **v2.1.0 cannot gate at all** — it has no honesty block to gate on.

## Honest reading of THIS bench

- The v2.1.0 = 100% is partly **definitional**: v2.1.0 has no honesty machinery, so it _cannot_ disclose these caveats. That is precisely the improvement — the machinery did not exist and now does.
- The load-bearing results are the other three: (1) **v2.2.0 = 0%** proves the machinery produces the correct disclosure on realistic windows (not just in unit fixtures), (2) the **control passes** — it does not cry wolf on a clean green, and (3) the verdict is now **CI-gateable** (`meetsHonestyBar`), which a bare green never was.
- Scenarios are hand-authored windows, but each `events` list is the real wire shape the SDK emits (a `BLIND_SPOT`/`TRUNCATED`/`SIGNAL` event), and the scoring runs the _real_ v2.2.0 functions — so this measures the shipped composition, not a mock.

## Verdict

On the dimension the fix-loop bench is blind to — **does a green lie?** — v2.2.0 is a measurable improvement: false-green rate 100% → 0%, with no over-flagging, and verdicts became gateable. This is the benchmark that actually verifies v2.2.0's value; the fix-loop bench measures a different (and, for a capable agent, unfavorable) axis.
