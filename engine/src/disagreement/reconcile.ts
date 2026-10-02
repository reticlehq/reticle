/**
 * Compare what the API SAID against what the page SHOWS.
 *
 * Every other check in Reticle reads one side. This reads both, which is the one comparison only
 * something living inside the app can make: the response body and the rendered text are in the same
 * process, and nothing else holds them at the same time. A screenshot has the render and not the
 * data; a network log has the data and not the render; a human reading either one sees a number that
 * looks right.
 *
 * Two findings, both measured on a real payments dashboard:
 *
 *  - **the wrong currency.** `GET /payments` returns `{amount: 7997, currency: "USD"}` and the row
 *    renders "₹79.97". The number is correct, the unit is not — a dollar amount presented as rupees.
 *    Every channel agrees: 200, the digits match the data, the page settles.
 *  - **a status that is never shown.** `GET /settlements` returns `status: "on_hold"` with
 *    `hold_reason: "kyc_documents_expired"`, and the badge reads "pending". A merchant reads
 *    "pending" and waits, while the payout is blocked on expired documents.
 *
 * Pure: response bodies and page text in, findings out. No session, no DOM, no clock.
 */

/** A finding: one field of one entity whose rendering disagrees with the data. */
export interface Mismatch {
  entity: string;
  field: string;
  /** What the API returned. */
  api: string;
  /** What the page shows instead — absent when the value simply never appears. */
  rendered?: string;
  why: string;
}

/**
 * Currency markers, symbol and code. Deliberately a closed list: currency is one of the few things an
 * app renders that has a fixed, publicly agreed vocabulary, which is what makes this checkable
 * without knowing anything about the app.
 */
const CURRENCY_MARKS: Record<string, readonly string[]> = {
  INR: ['₹', 'INR', 'Rs.', 'Rs '],
  USD: ['$', 'USD', 'US$'],
  EUR: ['€', 'EUR'],
  GBP: ['£', 'GBP'],
  JPY: ['¥', 'JPY'],
  AED: ['AED', 'د.إ'],
  SGD: ['SGD', 'S$'],
  AUD: ['AUD', 'A$'],
};

/** Currencies whose minor unit is not 1/100. Rendering these needs a different divisor. */
const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND']);

/** Fields that name a state — the ones a badge renders and a user acts on. */
const STATE_FIELDS = new Set(['status', 'state']);

const ITEM_KEYS = ['items', 'results', 'data', 'records', 'rows', 'entries'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return 'object' === typeof value && value !== null && !Array.isArray(value);
}

/** Every object carrying an `id`, at any depth. These are the things a UI renders as rows. */
export function entitiesIn(
  node: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(node)) {
    for (const item of node) entitiesIn(item, out);
    return out;
  }
  if (!isRecord(node)) return out;
  if (node['id'] !== undefined) out.push(node);
  for (const key of ITEM_KEYS) {
    if (node[key] !== undefined) entitiesIn(node[key], out);
  }
  return out;
}

/**
 * Every way a UI might print a minor-unit integer as a major-unit amount.
 *
 * Real interfaces group digits, and they do not agree on how: "44,573.44" in most of the world,
 * "44.573,44" across much of Europe, and "1,22,464.06" under the Indian lakh convention. Matching only
 * the ungrouped form finds nothing on any app that formats its money, which is all of them — measured
 * on a logistics console whose cells read "₹44,573.44" while the check searched for "44573.44".
 */
function majorForms(minor: number, currency: string): string[] {
  if (ZERO_DECIMAL.has(currency))
    return [String(minor), group(String(minor)), indian(String(minor))];
  const plain = (minor / 100).toFixed(2);
  const [whole = '', fraction = ''] = plain.split('.');
  return [
    plain,
    `${group(whole)}.${fraction}`,
    `${indian(whole)}.${fraction}`,
    // European: dots group, comma is the decimal separator.
    `${group(whole).replace(/,/g, '.')},${fraction}`,
  ];
}

/** Western grouping: every three digits from the right. */
function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Indian grouping: the last three digits, then pairs — 1,22,464. */
function indian(whole: string): string {
  if (whole.length <= 3) return whole;
  const last = whole.slice(-3);
  const rest = whole.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last}`;
}

/** Does the text show this amount marked as some OTHER currency? Returns that marker. */
function wrongCurrencyMark(text: string, amounts: string[], expected: string): string | undefined {
  for (const amount of amounts) {
    const mark = markBefore(text, amount, expected);
    if (mark !== undefined) return mark;
  }
  return undefined;
}

function markBefore(text: string, amount: string, expected: string): string | undefined {
  const at = text.indexOf(amount);
  if (-1 === at) return undefined; // this rendering is not on screen — try the next
  // Look just before the number, where a symbol or code sits. A window, not the whole page: the
  // point is what is attached to THIS amount.
  const before = text.slice(Math.max(0, at - 12), at);
  const expectedMarks = CURRENCY_MARKS[expected] ?? [expected];
  if (expectedMarks.some((mark) => before.includes(mark))) return undefined;
  for (const [code, marks] of Object.entries(CURRENCY_MARKS)) {
    if (code === expected) continue;
    for (const mark of marks) {
      if (before.includes(mark)) return mark;
    }
  }
  return undefined;
}

/** Every form a state value might legitimately be rendered as: `on_hold`, `on hold`, `On Hold`. */
function renderedForms(value: string): string[] {
  const spaced = value.replace(/[_-]+/g, ' ');
  return [value, spaced, spaced.replace(/\s+/g, '')];
}

function shows(text: string, value: string): boolean {
  const haystack = text.toLowerCase();
  return renderedForms(value).some((form) => haystack.includes(form.toLowerCase()));
}

/**
 * Compare entities against the page's rendered text.
 *
 * `pageText` is the visible text of the page — the snapshot's own tree is exactly this, so no new
 * capability is needed to obtain it.
 */
export function reconcile(bodies: readonly unknown[], pageText: string): Mismatch[] {
  const entities = bodies.flatMap((body) => entitiesIn(body));
  const found: Mismatch[] = [];
  const seen = new Set<string>();

  // Every value each state field took across the response set — used to tell "this value is simply
  // not rendered anywhere" (uninteresting) from "a DIFFERENT value of this same field is rendered"
  // (a mapping bug). Without that distinction the check would flag any field a UI chooses not to show.
  const vocabulary = new Map<string, Set<string>>();
  for (const entity of entities) {
    for (const [field, value] of Object.entries(entity)) {
      if (!STATE_FIELDS.has(field) || typeof value !== 'string') continue;
      const values = vocabulary.get(field) ?? new Set<string>();
      values.add(value);
      vocabulary.set(field, values);
    }
  }

  for (const entity of entities) {
    // An id is a string or a number in every API worth reconciling; anything else is not an identity
    // this can report against, so the record is skipped rather than stringified into nonsense.
    const raw = entity['id'];
    if (typeof raw !== 'string' && typeof raw !== 'number') continue;
    const id = String(raw);

    // Any numeric field on an entity that declares a currency is money in THAT currency. Checking a
    // fixed field name instead would only ever work on APIs that happen to call it `amount` — the
    // three real ones measured here use `amount`, `declaredValueMinor` and `total`.
    //
    // The check is still tight, because a value only counts when the page renders it AS money: the
    // number must appear with a currency marker attached. A non-money number that happens to share a
    // decimal form (a weight, a count) is rendered bare and never reaches the comparison.
    const currency = entity['currency'];
    if ('string' === typeof currency) {
      for (const [field, value] of Object.entries(entity)) {
        if (typeof value !== 'number' || 'currency' === field) continue;
        const printed = majorForms(value, currency);
        const wrong = wrongCurrencyMark(pageText, printed, currency);
        const key = `${id}:currency`;
        if (wrong === undefined || seen.has(key)) continue;
        seen.add(key);
        found.push({
          entity: id,
          field: 'currency',
          api: currency,
          rendered: wrong,
          why: `the API reports ${currency} ${String(value)} (minor units, field "${field}") and the page shows it marked "${wrong}" — the number is right and the currency is not, so the amount reads as a different one entirely`,
        });
      }
    }

    for (const [field, value] of Object.entries(entity)) {
      if (!STATE_FIELDS.has(field) || typeof value !== 'string') continue;
      if (shows(pageText, value)) continue;
      // Only interesting if the page renders SOME value of this field — otherwise the UI just does
      // not display it, which is a design choice and not a defect.
      const others = [...(vocabulary.get(field) ?? [])].filter((v) => v !== value);
      const shown = others.filter((v) => shows(pageText, v));
      const key = `${id}:${field}`;
      if (0 === shown.length || seen.has(key)) continue;
      seen.add(key);
      found.push({
        entity: id,
        field,
        api: value,
        why: `the API reports ${field}="${value}" for ${id}, and no rendering of that value appears on the page — while other values of the same field are shown (${shown.join(', ')}), so this record is being displayed as something it is not`,
      });
    }
  }
  return found;
}
