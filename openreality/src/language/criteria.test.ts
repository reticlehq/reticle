import { describe, it, expect } from 'vitest';
import { ChannelId } from '../vocabulary/channel.js';
import { criteriaToProgram, gradeCriteria } from './criteria.js';
import { typecheckProgram } from './typecheck.js';

/**
 * User-defined verification criteria, with NO new mechanism.
 *
 * "Verify my SEO" looks like it wants a plugin API. It does not. A criterion is a document of
 * actions and declared consequences over declared channels — which is what a flow already is — so
 * the extensibility comes from the language being general rather than from a new extension point per
 * use case. A plugin API per use case is how a verification tool ends up with an SEO plugin, an a11y
 * plugin and a performance plugin that each invent their own idea of what "passed" means.
 *
 * The consequence worth having: criteria TYPECHECK. An SEO rule that reads a channel the realm does
 * not observe is refused before it runs, instead of quietly reporting a pass it could never have
 * failed — which is the shape of every vacuous green this project exists to catch.
 */
const seo = [
  { name: 'title is present', capability: 'read', reads: [ChannelId.UI] },
  { name: 'canonical link is present', capability: 'read', reads: [ChannelId.UI] },
  { name: 'no client redirect chain', capability: 'read', reads: [ChannelId.ROUTE] },
];

describe('criteria are just a program', () => {
  it('compiles a criteria set into ordinary program steps', () => {
    const program = criteriaToProgram(seo);
    expect(program).toHaveLength(3);
    expect(program[0]?.capability).toBe('read');
  });

  it('typechecks against a realm like any other document', () => {
    const canRead = { capabilities: ['read'], channels: [ChannelId.UI, ChannelId.ROUTE] };
    expect(typecheckProgram(criteriaToProgram(seo), canRead)).toEqual([]);
  });

  it('is REFUSED when the realm cannot observe what a criterion reads', () => {
    const uiOnly = { capabilities: ['read'], channels: [ChannelId.UI] };
    const errors = typecheckProgram(criteriaToProgram(seo), uiOnly);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.detail).toContain(ChannelId.ROUTE);
  });
});

describe('a criteria verdict carries its own coverage', () => {
  it('reports what passed, what failed, and what could NOT be checked', () => {
    const verdict = gradeCriteria(seo, {
      'title is present': true,
      'canonical link is present': false,
      // 'no client redirect chain' deliberately absent — nothing answered it.
    });
    expect(verdict.passed).toEqual(['title is present']);
    expect(verdict.failed).toEqual(['canonical link is present']);
    expect(verdict.unchecked).toEqual(['no client redirect chain']);
  });

  it('is NOT a pass while anything went unchecked — silence is not a green', () => {
    const verdict = gradeCriteria(seo, { 'title is present': true });
    expect(verdict.verdict).toBe('unknown');
  });

  it('passes only when every criterion was checked and held', () => {
    const verdict = gradeCriteria(seo, {
      'title is present': true,
      'canonical link is present': true,
      'no client redirect chain': true,
    });
    expect(verdict.verdict).toBe('yes');
  });

  it('a failure outranks an unchecked criterion — a known break is worse news than a gap', () => {
    const verdict = gradeCriteria(seo, { 'title is present': false });
    expect(verdict.verdict).toBe('no');
  });
});
