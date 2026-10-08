import { describe, expect, it } from 'vitest';
import { heuristicFillValue } from './fill-values.js';

describe('what the crawl types into a field', () => {
  it('reads the label for the kinds of field it recognises', () => {
    expect(heuristicFillValue('Email address')).toBe('harness@reticle.dev');
    expect(heuristicFillValue('Refund amount')).toBe('2');
    expect(heuristicFillValue('Search transactions')).toBe('a');
  });

  it('types a recognisable placeholder into anything else', () => {
    expect(heuristicFillValue('Notes for the warehouse')).toBe('reticle harness');
  });
});
