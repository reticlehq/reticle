/**
 * What to type into a field, and the one place in a drive worth paying a generating model for.
 *
 * A System One model answers typed questions against a state; it cannot write a string. That is not
 * a shortcoming to route around everywhere — it is why the drive is two orders of magnitude cheaper,
 * and every decision it makes (which tool, which element, what should follow) is a decision, not a
 * composition. But a text field is a composition. "A card number", "a search term that returns
 * results", "a description a human would write" cannot be enumerated from the page, and a label-keyed
 * table of guesses is what stands in for them today.
 *
 * ## Why this is escalation rather than partnership
 *
 * Put a generating model in the per-turn loop and you pay its per-turn tax on every step, which is
 * the cost the cheap driver exists to avoid. Measured across 91 recorded flows on a production
 * dashboard: 413 clicks, 26 text steps. Text is about 6% of what a drive does. So the model is
 * called for the 6%, never for the 94%, and a drive with no text fields never calls it at all.
 *
 * ## Why it is cached, and cached where it is
 *
 * A generated value is paid for ONCE and then belongs to the project: the same field on the same
 * app wants the same value tomorrow, and a replay must send exactly what the recording sent or it
 * is not a replay. Writing them to `.reticle` makes the second drive free, makes the values
 * reviewable by a human who can correct a bad one by hand, and keeps them out of the model's way
 * entirely. It is the same economics as the flows themselves: pay once, replay forever.
 *
 * ## What it must never do
 *
 * Fill a slot, never propose a call. The driver decides what to click and what to claim; this
 * answers one question — "what text goes in this box" — and a wrong answer costs one act, not a
 * wrong verdict. Nothing here touches what is judged.
 */

import {
  DEFAULT_HARNESS_BASE_URL,
  type HarnessDriverOptions,
  type HarnessFetch,
} from './driver.js';

/** Deliberately small. A field value is a phrase; anything longer is the model misunderstanding. */
const MAX_TOKENS = 64;

const ANTHROPIC_VERSION = '2023-06-01';
const MESSAGES_PATH = '/v1/messages';

/**
 * How many values one drive will generate.
 *
 * The cache makes the steady state nearly free, but the FIRST drive on a form-heavy app is the one
 * that pays, and an uncapped loop on a page with forty inputs is a bill nobody agreed to. Past the
 * cap the heuristic answers, which is what every drive used before this existed.
 */
const MAX_PER_DRIVE = 12;

/** What the caller must be able to do for values to survive past this drive. */
export interface FillCache {
  get(label: string): string | undefined;
  set(label: string, value: string): void;
}

/**
 * The fallback, and still the answer for most fields.
 *
 * An exploration drive needs PLAUSIBLE input, not creative input: the engine is judging what the app
 * did with the value, not the value. A field that rejects everything here is itself worth finding,
 * and shows up as an act that did not settle.
 */
export function heuristicFillValue(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('email')) return 'harness@reticle.dev';
  if (l.includes('password')) return 'password';
  if (l.includes('url') || l.includes('link')) return 'https://example.com';
  if (l.includes('phone') || l.includes('tel')) return '5550100';
  if (l.includes('date')) return '2026-01-01';
  if (l.includes('amount') || l.includes('price') || l.includes('qty') || l.includes('quantity'))
    return '2';
  if (l.includes('search') || l.includes('filter')) return 'a';
  if (l.includes('number') || l.includes('count')) return '42';
  return 'reticle harness';
}

/**
 * Whether a label is worth spending a model call on.
 *
 * The heuristic is RIGHT about an email box and an amount box, and a generated "john@example.com"
 * is not an improvement on `harness@reticle.dev`. What it cannot do is a field whose label it does
 * not recognise at all, where it falls back to typing the words "reticle harness" into whatever the
 * app asked for. That fallback is the whole of what generation is for.
 */
export function needsGeneration(label: string): boolean {
  return heuristicFillValue(label) === heuristicFillValue('');
}

const PROMPT = (label: string, context: string): string =>
  `A test harness is filling in a form field on a web application so it can check what the app does with the input.\n\n` +
  `The field is labelled: "${label}"\n` +
  `${context}\n\n` +
  `Reply with ONLY the value to type. No quotes, no explanation, no markdown. It must be something a ` +
  `real user would plausibly enter, and short. If the field wants an identifier or a code, invent a ` +
  `well-formed one.`;

/** One string from a generating model, or nothing. Never throws: a drive must not fail over a field. */
async function generateOne(
  options: HarnessDriverOptions,
  label: string,
  context: string,
): Promise<string | undefined> {
  const call: HarnessFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const baseUrl = options.baseUrl ?? DEFAULT_HARNESS_BASE_URL;
  try {
    const res = await call(`${baseUrl}${MESSAGES_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': options.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: options.model ?? 'claude-sonnet-5',
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content: PROMPT(label, context) }],
      }),
    });
    if (!res.ok) return undefined;
    const parsed: unknown = JSON.parse(await res.text());
    const content = (parsed as { content?: { type?: string; text?: string }[] }).content ?? [];
    const text = content
      .filter((block) => 'text' === block.type)
      .map((block) => block.text ?? '')
      .join('')
      .trim()
      .split('\n')[0];
    if (text === undefined || 0 === text.length) return undefined;
    // A model asked for one value occasionally answers with a sentence about the value. Anything
    // long enough to be prose is not a field value, and typing prose proves nothing about the app.
    return 80 < text.length ? undefined : text.replace(/^["']|["']$/g, '');
  } catch {
    // Offline, refused, rate-limited, malformed. All the same answer: use the heuristic.
    return undefined;
  }
}

/**
 * The seam the driver calls: a label in, a value out, always.
 *
 * Three layers, cheapest first, and the expensive one is skipped entirely unless the two above it
 * have nothing better than "type the words reticle harness into this box".
 */
export function fillValues(deps: {
  cache?: FillCache;
  generator?: HarnessDriverOptions;
  /** One line about where the drive is, so a value suits the page it is typed on. */
  context?: () => string;
}): (label: string) => Promise<string> {
  let spent = 0;
  return async (label: string): Promise<string> => {
    const cached = deps.cache?.get(label);
    if (cached !== undefined) return cached;

    const fallback = heuristicFillValue(label);
    if (deps.generator === undefined || !needsGeneration(label) || MAX_PER_DRIVE <= spent)
      return fallback;

    spent += 1;
    const generated = await generateOne(deps.generator, label, deps.context?.() ?? '');
    if (generated === undefined) return fallback;
    // Cached under the LABEL, not the ref: refs expire with the page, labels are what the next drive
    // and every replay will meet again.
    deps.cache?.set(label, generated);
    return generated;
  };
}
