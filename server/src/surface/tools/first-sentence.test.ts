import { describe, expect, it } from 'vitest';
import { CATALOGUE_SUMMARY_LENGTH, MCP_SUMMARY_LENGTH, firstSentence } from './first-sentence.js';
import { TOOLS } from './tools.js';

/**
 * A summary that cuts an obligation out of a tool description.
 *
 * There were two copies of this function and only one knew about abbreviations, so the tool
 * CATALOGUE -- the surface an agent reads to discover what exists -- rendered `reticle_session` as
 * "…adjusts the presenter session (e.g." and stopped. Everything after it was gone, including
 * `"yield" … is MANDATORY before you stop driving`. The one instruction the product calls mandatory
 * was missing from the only place an agent would have found it, and every gate was green: both
 * copies did exactly what their own tests said.
 */
describe('the first sentence of a tool description', () => {
  it('does not cut inside an abbreviation', () => {
    expect(firstSentence('Alpha e.g. beta gamma. Delta.')).toContain('gamma');
  });

  it.each(['e.g.', 'i.e.', 'etc.', 'vs.', 'cf.'])('survives %s', (abbr) => {
    expect(firstSentence(`Alpha ${abbr} beta gamma.`)).toContain('gamma');
  });

  it('stops at a real sentence end', () => {
    expect(firstSentence('First one. Second one.')).toBe('First one.');
  });

  it('takes only the first line', () => {
    expect(firstSentence('Headline\nbody text')).toBe('Headline');
  });

  /** The two callers disagree about width, and that is the only thing they should disagree about. */
  it('truncates to the width it is given', () => {
    const long = `${'a'.repeat(300)}.`;
    expect(firstSentence(long, CATALOGUE_SUMMARY_LENGTH)).toHaveLength(CATALOGUE_SUMMARY_LENGTH);
    expect(firstSentence(long, MCP_SUMMARY_LENGTH)).toHaveLength(MCP_SUMMARY_LENGTH);
  });

  /**
   * The incident, as a property.
   *
   * A tool that states an obligation must still state it after the catalogue has shortened it,
   * because the catalogue is where the obligation is read. This fails if somebody reorders a
   * description so the MANDATORY clause drifts past the cut -- which is exactly how it broke.
   */
  it('keeps every MANDATORY clause inside the catalogue summary', () => {
    const lost = TOOLS.filter(
      (tool) =>
        tool.description.includes('MANDATORY') &&
        !firstSentence(tool.description, CATALOGUE_SUMMARY_LENGTH).includes('MANDATORY'),
    ).map((tool) => tool.name);
    expect(
      lost,
      `these tools tell the agent something is MANDATORY and then lose it in the catalogue, ` +
        `which is the surface the agent actually reads: ${lost.join(', ')}`,
    ).toEqual([]);
  });

  /** A passing test over zero tools proves nothing; this is the corpus the check above relies on. */
  it('has MANDATORY clauses to check', () => {
    expect(TOOLS.filter((t) => t.description.includes('MANDATORY')).length).toBeGreaterThan(0);
  });
});
