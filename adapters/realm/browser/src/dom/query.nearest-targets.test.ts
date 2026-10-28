/**
 * A query that matches nothing lists the nearest targets, with refs, so the retry is one call.
 *
 * The field defect: an action refused for a missing target, and most agents then read the page in a
 * loop to find what they meant. The list is advice. The query still reports zero matches.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { QueryBy, type NearestTarget } from '@reticlehq/core';
import { MAX_NEAREST_NAME, nameSimilarity, runQuery } from './query.js';

function nearestOf(query: Parameters<typeof runQuery>[0]): NearestTarget[] | undefined {
  const result = runQuery(query);
  expect(result.count).toBe(0);
  return result.hint?.nearest;
}

describe('a query that matched nothing lists the nearest targets', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('ranks the asked role by name similarity and gives a ref for each', () => {
    document.body.innerHTML =
      '<button>Save draft</button><button>Save</button><button>Cancel</button>';
    const nearest = nearestOf({ by: QueryBy.ROLE, value: 'button', name: 'Sav' }) ?? [];
    expect(nearest.map((t) => t.name)).toEqual(['Save', 'Save draft', 'Cancel']);
    expect(nearest.every((t) => 'button' === t.role && /^e\d+$/.test(t.ref))).toBe(true);
  });

  it('lists the buttons for a name that is not like any of them, because the role matches', () => {
    document.body.innerHTML =
      '<button>Save draft</button><button>Save</button><button>Cancel</button>';
    const nearest = nearestOf({ role: 'button', name: 'Submit' }) ?? [];
    expect(nearest.map((t) => t.name)).toEqual(['Save draft', 'Save', 'Cancel']);
  });

  it('puts the asked role before a closer name with another role', () => {
    document.body.innerHTML = '<a href="#">Save</a><button>Discard</button>';
    const nearest = nearestOf({ role: 'button', name: 'Save' }) ?? [];
    expect(nearest.map((t) => `${t.role}:${t.name}`)).toEqual(['button:Discard', 'link:Save']);
  });

  it('answers a text query from the targets whose names are like the text', () => {
    document.body.innerHTML = '<button>Save draft</button><button>Cancel</button>';
    expect(nearestOf({ text: 'Save drafts' })?.map((t) => t.name)).toEqual(['Save draft']);
  });

  it('gives no list when nothing on the page is like the target', () => {
    document.body.innerHTML = '<a href="#">Home</a><p>Welcome</p>';
    expect(nearestOf({ role: 'button', name: 'Zzz' })).toBeUndefined();
  });

  it('skips a hidden target', () => {
    document.body.innerHTML = '<button style="display:none">Save</button><button>Cancel</button>';
    expect(nearestOf({ role: 'button', name: 'Sav' })?.map((t) => t.name)).toEqual(['Cancel']);
  });

  it('holds at most three targets', () => {
    document.body.innerHTML =
      '<button>A1</button><button>A2</button><button>A3</button><button>A4</button>';
    expect(nearestOf({ role: 'button', name: 'B' })).toHaveLength(3);
  });

  it('cuts a long name and says that it did', () => {
    const long = 'Save '.repeat(30).trim();
    document.body.innerHTML = `<button>${long}</button><button>Save</button>`;
    const nearest = nearestOf({ role: 'button', name: 'Sav' }) ?? [];
    const cut = nearest.find((t) => true === t.nameTruncated);
    expect(cut?.name).toHaveLength(MAX_NEAREST_NAME);
    expect(nearest.find((t) => 'Save' === t.name)?.nameTruncated).toBeUndefined();
  });
});

describe('nameSimilarity', () => {
  it('is 1 for the same name and 0 for names with no letter pair in common', () => {
    expect(nameSimilarity('Save', 'save')).toBe(1);
    expect(nameSimilarity('Sav', 'Cancel')).toBe(0);
  });

  it('scores a prefix above a longer name that holds it', () => {
    expect(nameSimilarity('Sav', 'Save')).toBeGreaterThan(nameSimilarity('Sav', 'Save draft'));
  });
});
