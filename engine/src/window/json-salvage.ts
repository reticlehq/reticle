/**
 * Read what CAN be read out of a truncated JSON payload.
 *
 * Response bodies are capped (8192 bytes) so one enormous payload cannot blow the transport budget.
 * The cap is right; treating what it produces as "no body" is not. Measured on a 10,000-row console:
 * the list response is 19,932 bytes, arrives truncated mid-object, `JSON.parse` throws, and every
 * body-based check — currency reconciliation, per-item failures, unit mismatches — silently reported
 * nothing on the one page with the most data to be wrong about.
 *
 * Worse, the tool then advised turning on body capture, which was already on. Advice that cannot
 * work is more expensive than silence: it sends the reader to change a setting that is already
 * correct, and teaches them the tool does not know what it is looking at.
 *
 * A truncated array of records is still mostly complete records. This recovers the ones that closed
 * before the cut and reports how many it had to drop, so a partial answer is delivered AS partial
 * rather than as a clean one.
 */

/**
 * Complete `{...}` objects inside a truncated payload, in order.
 *
 * NOT top-level ones: a cut body is typically `{"rows":[{…},{…},{…` where the OUTER brace never
 * closes, so nothing at depth 0 completes and a depth-0 scan recovers exactly nothing. The records
 * are one level in.
 *
 * Objects are kept only at the SHALLOWEST depth at which anything closes — that is the record level.
 * Keeping every depth would also return each record's nested children (a shipment's legs, an order's
 * line items), and those carry their own `id` and `status`, which would pollute the comparison with
 * values that were never meant to be rendered as rows.
 */
function completeObjects(text: string): string[] {
  const found: { depth: number; text: string }[] = [];
  let depth = 0;
  const starts: number[] = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if ('\\' === ch) escaped = true;
      else if ('"' === ch) inString = false;
      continue;
    }
    if ('"' === ch) {
      inString = true;
      continue;
    }
    if ('{' === ch) {
      starts.push(i);
      depth += 1;
      continue;
    }
    if ('}' === ch) {
      depth -= 1;
      // A negative depth means the cut removed an opening brace; nothing further is trustworthy.
      if (depth < 0) break;
      const start = starts.pop();
      if (start !== undefined) found.push({ depth: depth + 1, text: text.slice(start, i + 1) });
    }
  }
  if (0 === found.length) return [];
  const shallowest = Math.min(...found.map((f) => f.depth));
  return found.filter((f) => f.depth === shallowest).map((f) => f.text);
}

interface Salvaged {
  /** Parsed values — one whole body, or the records recovered from a truncated one. */
  values: unknown[];
  /** True when the payload was incomplete and only part of it could be read. */
  partial: boolean;
}

/**
 * Parse a body, falling back to whole records when it was cut short.
 *
 * The nesting caveat is real and stated rather than hidden: an object cut mid-nesting contributes its
 * completed CHILDREN instead of itself, so a salvaged set can hold records the envelope would have
 * grouped differently. For field-level comparison — is this id's currency rendered correctly — that
 * costs nothing, because each record still carries its own id and its own fields.
 */
export function salvageJson(raw: string): Salvaged {
  try {
    return { values: [JSON.parse(raw)], partial: false };
  } catch {
    // fall through to record-level recovery
  }
  const values: unknown[] = [];
  for (const chunk of completeObjects(raw)) {
    try {
      values.push(JSON.parse(chunk));
    } catch {
      // a chunk that still will not parse is simply not recovered
    }
  }
  return { values, partial: true };
}
