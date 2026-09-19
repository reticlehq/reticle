// Minimal Jev (TypeSafe System One) client + the verification question battery.
//
// Jev takes a STATE and a set of typed QUESTIONS and answers all of them in one parallel pass. It
// returns typed values — a probability, a choice, a score — not prose, so there is nothing to parse
// and nothing to rationalise.
//
// Two facts that shape every caller here, both measured by bench/harness/jev-probe.mjs:
//   - adding questions is nearly free. Seven questions cost 1.029x the input tokens of one against
//     the same 17k-char state, and latency is flat. The price is the STATE, so ask the whole battery
//     in one call and never split it per-question. (An earlier run of that probe had seven questions
//     coming back FASTER than one, which is not a thing that can happen: the one-question call ran
//     first and paid for the TLS handshake. Interleaving fixed it. Quote the token ratio, not the
//     latency ratio — the first is a property of the model, the second of whoever's laptop ran it.)
//   - the answer is a probability, not a verdict. `noul` is 0..1 and a choice carries a confidence.
//     Thresholding is the CALLER's job, deliberately not done here.
//
// No SDK: this is one POST. `fetch` is built into node.

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

/** $ per million input tokens. Output is free. Published price, 2026-09. */
export const JEV_INPUT_PRICE_PER_MTOK = 0.042;

/**
 * The battery.
 *
 * Every question is deliberately ATOMIC — one narrow thing, phrased as a statement to be judged
 * rather than a task to be performed. TypeSafe's own guidance is that System One models degrade when
 * a question bundles several judgements, and that matches what this repo already learned the hard
 * way: "is the app working?" is not a question, it is an essay prompt, and an essay prompt is where
 * a false green comes from.
 *
 * `consequence_happened` is the one that decides the verdict. The rest are the evidence-quality
 * questions Reticle already asks in code — they exist so a verdict can be WITHHELD (unknown) instead
 * of guessed, which is the distinction the whole verification layer rests on.
 */
export const VERIFICATION_QUESTIONS = {
  consequence_happened: {
    type: 'noul',
    instructions:
      'The specific intended consequence stated under INTENT actually occurred, as shown by the observed evidence.',
  },
  evidence_shows_it: {
    type: 'noul',
    instructions:
      'The evidence contains direct observation of the outcome, rather than only describing what the code is supposed to do.',
  },
  capture_clean: {
    type: 'noul',
    instructions:
      'The evidence is complete and settled, rather than truncated, empty, or captured while the page was still changing.',
  },
  app_errored: {
    type: 'noul',
    instructions:
      'The application logged an error or exception, or a network request failed, during the observed window.',
  },
  ui_contradicts_state: {
    type: 'noul',
    instructions:
      'What the interface displays disagrees with the application state or the network responses behind it.',
  },
  verdict: {
    type: 'choice',
    instructions:
      'The verification verdict for the stated intent, judged only on the evidence given.',
    criteria: {
      pass: 'The evidence positively shows the intended consequence happened.',
      fail: 'The evidence positively shows the intended consequence did not happen, or something broke.',
      unknown: 'The evidence is insufficient to decide either way.',
    },
  },
  severity: {
    type: 'score',
    instructions: 'How badly any defect visible in the evidence affects the person using the app.',
    criteria: ['Nothing is wrong', 'Cosmetic or recoverable', 'Blocks the user or corrupts data'],
  },
};

/**
 * One call. Throws on a non-2xx so a caller can never mistake an outage for a verdict — a judge that
 * returns "unknown" when the network is down is indistinguishable from one that looked and could not
 * tell, and this repo has already paid for that confusion once.
 */
export async function askJev({
  state,
  questions = VERIFICATION_QUESTIONS,
  apiKey,
  url = JEV_URL,
  model = JEV_MODEL,
}) {
  const key = apiKey ?? process.env.JEV_API_KEY;
  if (!key) throw new Error('JEV_API_KEY is not set');

  const startedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, model, questions }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`jev ${res.status}: ${body.slice(0, 400)}`);

  const parsed = JSON.parse(body);
  return { ...parsed, ms: Date.now() - startedAt };
}

/** What one call cost, in dollars. Output tokens are free on Jev, so they are deliberately not counted. */
export function jevCostUsd(usage) {
  return ((usage?.input_tokens ?? 0) / 1_000_000) * JEV_INPUT_PRICE_PER_MTOK;
}
