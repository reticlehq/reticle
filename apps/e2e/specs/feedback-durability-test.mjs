// Feedback must survive the network. Proven against a real CLI process, not a mock.
//
// Feedback is the only qualitative channel this product has and it carries an agent's whole
// root-cause analysis. It was sent on the same 2-second fire-and-forget budget as a usage counter,
// with no retry and no persistence, so a 1.3-second hiccup destroyed the report. Measured to the
// collector with a WARM DNS cache: 0.694s total, a third of the budget gone before a byte of payload
// moved — and that is the GOOD case. The report that exposed this survived only because its author
// had written the markdown by hand first.
//
// Three properties, each checked against a real `reticle feedback` run:
//   1. a report that CANNOT be delivered is still on disk, and the receipt says where;
//   2. a report that CAN be delivered leaves the outbox empty — no unbounded growth, no duplicates;
//   3. filing from inside a Reticle source checkout still works (with telemetry not explicitly
//      opted out — an explicit RETICLE_TELEMETRY=0, as this repo's own .env sets, is still honoured). That guard exists so a fresh clone
//      does not phone home on first `reticle serve` — a rule about PASSIVE collection. Somebody typed
//      the feedback. It silently discarded every report from anyone dogfooding their own checkout.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CLI = path.join(ROOT, 'packages', 'server', 'dist', 'cli.js');
const OUTBOX = path.join(homedir(), '.reticle', 'feedback-outbox.jsonl');

let pass = 0;
let fail = 0;
const chk = (label, ok, detail = '') => {
  console.log(`   ${ok ? '✅' : '❌'} ${label}${detail ? '  — ' + detail : ''}`);
  ok ? (pass += 1) : (fail += 1);
};

const outboxLines = () => {
  if (!existsSync(OUTBOX)) return [];
  return readFileSync(OUTBOX, 'utf8')
    .split('\n')
    .filter((line) => 0 < line.trim().length);
};

/** Run `reticle feedback` and return its combined output. Never throws — a non-zero exit is data. */
function feedback(text, env) {
  try {
    return execFileSync('node', [CLI, 'feedback', '--bug', text], {
      cwd: ROOT,
      // RETICLE_TELEMETRY=1 overrides this repo's gitignored `.env`, which sets it to 0 so that
      // developing Reticle is never counted as using it. Without this the spec measures the
      // MACHINE's opt-out instead of the code, and reports a product failure that is not one —
      // which is exactly what its first run did.
      env: { ...process.env, RETICLE_TELEMETRY: '1', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  } catch (error) {
    return `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`;
  }
}

console.log('\n=== FEEDBACK DURABILITY: a report must survive a bad network ===');

const before = outboxLines().length;

// ── 1. Undeliverable: the endpoint refuses, so the report must be on disk ─────────────────────
// Port 1 on loopback is closed on every machine, so this is a real connection failure rather than a
// simulated one — the same code path a DNS miss or a dead route takes.
{
  const out = feedback('e2e durability probe — undeliverable', {
    RETICLE_TELEMETRY_URL: 'http://127.0.0.1:1',
  });
  const after = outboxLines();
  chk(
    'an undeliverable report is written to the outbox',
    after.length > before,
    `${String(before)} -> ${String(after.length)} line(s)`,
  );
  chk(
    '  and the receipt says it was SAVED rather than lost',
    /saved|outbox|nothing was lost/i.test(out),
    out.trim().split('\n').pop()?.slice(0, 110) ?? '(no output)',
  );
  chk(
    '  and never claims it was filed',
    !/"sent"\s*:\s*true/.test(out),
    'sent:true would be the old lie',
  );
}

// ── 2. Deliverable: the outbox drains ─────────────────────────────────────────────────────────
// RETICLE_TELEMETRY_FILE records to a local JSONL and sends nothing, which is a SUCCESSFUL delivery
// as far as the emitter is concerned — exactly what is needed to prove the drain without posting a
// test report to the real collector.
{
  const sink = path.join(mkdtempSync(path.join(tmpdir(), 'reticle-fb-')), 'events.jsonl');
  const queuedBefore = outboxLines().length;
  const out = feedback('e2e durability probe — deliverable', { RETICLE_TELEMETRY_FILE: sink });
  const recorded = existsSync(sink) ? readFileSync(sink, 'utf8') : '';
  chk(
    'a deliverable report reaches the sink',
    recorded.includes('feedback'),
    `${String(recorded.split('\n').filter(Boolean).length)} event(s) recorded`,
  );
  chk(
    '  and the outbox does not grow — a delivered report is removed',
    outboxLines().length <= queuedBefore,
    `${String(queuedBefore)} -> ${String(outboxLines().length)}`,
  );
  chk('  and the receipt does not warn about losing it', !/NOT filed/i.test(out));
  rmSync(path.dirname(sink), { recursive: true, force: true });
}

// ── 3. Filing from inside the Reticle source checkout ─────────────────────────────────────────
// cwd IS the reticle repo here, which is the case that used to discard the report and print
// "not sent, unknown reason".
{
  const sink = path.join(mkdtempSync(path.join(tmpdir(), 'reticle-fb-')), 'events.jsonl');
  feedback('e2e durability probe — from the checkout', { RETICLE_TELEMETRY_FILE: sink });
  const recorded = existsSync(sink) ? readFileSync(sink, 'utf8') : '';
  chk(
    'feedback filed from the reticle checkout is not silently discarded',
    recorded.includes('feedback'),
    recorded.length > 0 ? 'recorded' : 'NOTHING recorded — the checkout guard is eating reports',
  );
  rmSync(path.dirname(sink), { recursive: true, force: true });
}

// Leave the machine as we found it: drop only the probes this spec queued.
{
  const mine = outboxLines().filter((line) => line.includes('e2e durability probe'));
  if (0 < mine.length) {
    const kept = outboxLines().filter((line) => !line.includes('e2e durability probe'));
    const { writeFileSync } = await import('node:fs');
    writeFileSync(OUTBOX, 0 === kept.length ? '' : `${kept.join('\n')}\n`, 'utf8');
  }
  chk('the spec cleans up after itself', 0 === outboxLines().filter((l) => l.includes('e2e durability probe')).length);
}

console.log(`\n${0 === fail ? '✅' : '❌'} FEEDBACK DURABILITY (${pass} passed, ${fail} failed)`);
process.exit(0 === fail ? 0 : 1);
