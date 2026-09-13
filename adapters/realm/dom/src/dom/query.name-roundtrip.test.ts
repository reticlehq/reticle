/**
 * Whatever name a query REPORTS for an element, passing that name back must find that element.
 *
 * This is the round-trip the recorder depends on. It reads an element with `reticle_query`, saves
 * `{ kind: "role", role, name }` from what it was told, and replay re-resolves by exactly that pair.
 * If the name a query PRINTS is computed differently from the name a query MATCHES, a flow records
 * clean, grades `asserted` with `degraded: 0`, and then drifts on every single replay — a false fact
 * written to disk, which is worse than a failure because it looks like a working test.
 *
 * Reported against `<input type="search" placeholder="Search User">` with no label and no
 * aria-label: query reported `name: "Search User"`, and the replay lookup matched nothing.
 *
 * The property is stated here as an invariant over shapes where the accessible name comes from
 * Reticle's own local engine: placeholder, title, value and ordinary text. If a future change makes
 * matching and reporting disagree again, a user's recorded flow should not be the first signal.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { runQuery } from './query.js';
import { QueryBy } from '@reticlehq/core';

beforeEach(() => {
  document.body.innerHTML = '';
});

/** Ask for everything with this role, then ask again by the name we were told. */
function roundTrip(role: string): { reported: string; refound: number } {
  const first = runQuery({ by: QueryBy.ROLE, value: role });
  const reported = first.elements[0]?.name ?? '';
  const again = runQuery({ by: QueryBy.ROLE, value: role, name: reported });
  return { reported, refound: again.count };
}

describe('a reported name is a usable name', () => {
  it("round-trips a placeholder-derived name with Reticle's own role", () => {
    document.body.innerHTML = '<input type="search" placeholder="Search User" />';
    const first = runQuery({ by: QueryBy.ROLE, value: 'textbox' });
    const role = first.elements[0]?.role ?? '';
    const name = first.elements[0]?.name ?? '';
    expect({ role, name }).toEqual({ role: 'textbox', name: 'Search User' });
    // The pair the recorder would write to disk, re-resolved the way replay re-resolves it.
    expect(runQuery({ by: QueryBy.ROLE, value: role, name }).count).toBe(1);
    // Reticle reports this input as `textbox`, so the former second-library role is no longer a match.
    expect(runQuery({ by: QueryBy.ROLE, value: 'searchbox', name }).count).toBe(0);
  });

  it('round-trips a label-derived name', () => {
    document.body.innerHTML = '<label for="a">Email</label><input id="a" />';
    const { reported, refound } = roundTrip('textbox');
    expect(reported).toBe('Email');
    expect(refound).toBe(1);
  });

  it('round-trips a name carrying a required marker', () => {
    // `Username *` — the asterisk is part of the visible label, so it is part of the name we print.
    document.body.innerHTML = '<label for="u">Username *</label><input id="u" />';
    const { reported, refound } = roundTrip('textbox');
    expect(reported).toContain('Username');
    expect(refound).toBe(1);
  });

  it('round-trips a title-derived name', () => {
    document.body.innerHTML = '<button title="Close dialog"></button>';
    const { reported, refound } = roundTrip('button');
    expect(reported).toBe('Close dialog');
    expect(refound).toBe(1);
  });

  it('round-trips an ordinary text-content name', () => {
    document.body.innerHTML = '<button>Save changes</button>';
    const { reported, refound } = roundTrip('button');
    expect(reported).toBe('Save changes');
    expect(refound).toBe(1);
  });

  it('round-trips a submit input named from its value attribute', () => {
    // The caption IS the value: `<input type="submit" value="Send">` renders a button reading Send.
    // The name engine reads `value`, so matching must too - `by: text` already found this element
    // by "Send", and a matcher that could not would split one control across two vocabularies.
    document.body.innerHTML = '<form><input type="submit" value="Send" /></form>';
    const { reported, refound } = roundTrip('button');
    expect(reported).toBe('Send');
    expect(refound).toBe(1);
  });

  it('round-trips a name contributed by an img alt inside the button', () => {
    // An icon-only button names itself through the image's alternative text; walking text nodes
    // alone reported it nameless even though the page renders a visible tooltip from the same alt.
    document.body.innerHTML = '<button><img alt="Close" /></button>';
    const { reported, refound } = roundTrip('button');
    expect(reported).toBe('Close');
    expect(refound).toBe(1);
  });

  it('does not match a DIFFERENT control that merely looks similar', () => {
    document.body.innerHTML = '<button>Save</button><button>Save all</button>';
    expect(runQuery({ by: QueryBy.ROLE, value: 'button', name: 'Save' }).count).toBe(1);
  });
});
