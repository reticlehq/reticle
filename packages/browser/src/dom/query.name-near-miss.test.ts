/**
 * A role+name query is EXACT, and a miss said nothing about what was actually there.
 *
 * Reported from the field as "exact-only name matching costs real calls": a query for the button
 * named "Mesh" against a page whose button reads "2 Mesh" returns nothing, and the agent has to
 * spend a snapshot to discover a label it was one word away from.
 *
 * Loosening the match itself is the wrong fix and a dangerous one. Substring matching on `name`
 * would make a query for "Save" also select "Save and close" and "Autosave", and the failure mode
 * there is acting on the WRONG control, which is worse than not finding the right one. Testing
 * Library keeps `getByRole(name)` exact for the same reason.
 *
 * So the exactness stays and the MISS gets more useful: a zero-match role+name query reports the
 * names that role does have which nearly matched. The recovery costs no extra round trip, and no
 * query silently selects something the caller did not ask for.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { runQuery } from './query.js';
import { QueryBy } from '@reticlehq/core';

const hintOf = (name: string, by = QueryBy.ROLE, value = 'button'): Record<string, unknown> => {
  const result = runQuery({ by, value, name });
  expect(result.count).toBe(0);
  return (result.hint ?? {}) as unknown as Record<string, unknown>;
};

describe('a role+name query that missed says what that role DOES have', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('names the label that contains the one asked for', () => {
    document.body.innerHTML = '<button>2 Mesh</button><button>Geometry</button>';
    expect(hintOf('Mesh')['nameNearMiss']).toEqual(['2 Mesh']);
  });

  it('names a label the query was too long for, which is the same mistake reversed', () => {
    document.body.innerHTML = '<button>Mesh</button>';
    expect(hintOf('2 Mesh')['nameNearMiss']).toEqual(['Mesh']);
  });

  it('ignores case and surrounding whitespace, as the exact matcher already does', () => {
    document.body.innerHTML = '<button>  Run   MESH  </button>';
    expect(hintOf('mesh')['nameNearMiss']).toEqual(['Run MESH']);
  });

  it('says nothing when no name is close — an ordinary miss stays short', () => {
    document.body.innerHTML = '<button>Geometry</button><button>Results</button>';
    expect(hintOf('Mesh')['nameNearMiss']).toBeUndefined();
  });

  it('only offers names of the ROLE that was asked for', () => {
    // A link called "2 Mesh" is not a near miss for a BUTTON called Mesh: acting on it would be
    // acting on a different control, which is the thing this hint exists to avoid recommending.
    document.body.innerHTML = '<a href="/m">2 Mesh</a><button>Geometry</button>';
    expect(hintOf('Mesh')['nameNearMiss']).toBeUndefined();
  });

  it('does not appear at all when the query MATCHED', () => {
    document.body.innerHTML = '<button>Mesh</button>';
    const result = runQuery({ by: QueryBy.ROLE, value: 'button', name: 'Mesh' });
    expect(result.count).toBe(1);
    expect(result.hint).toBeUndefined();
  });
});
