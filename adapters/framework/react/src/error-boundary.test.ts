import { describe, it, expect } from 'vitest';
import { buildErrorBoundaryData } from './error-boundary.js';

describe('buildErrorBoundaryData', () => {
  it('extracts message + stack from an Error and the component stack from errorInfo', () => {
    const error = new Error('render blew up');
    const data = buildErrorBoundaryData(error, { componentStack: '\n    at Checkout\n    at App' });
    expect(data.message).toBe('render blew up');
    expect(data.stack).toContain('render blew up');
    expect(data.componentStack).toContain('at Checkout');
  });

  it('stringifies a non-Error throw and omits absent stacks', () => {
    const data = buildErrorBoundaryData('a string was thrown');
    expect(data.message).toBe('a string was thrown');
    expect(data.stack).toBeUndefined();
    expect(data.componentStack).toBeUndefined();
  });

  it('caps a very long stack', () => {
    const error = new Error('x');
    error.stack = 'x'.repeat(9000);
    expect((buildErrorBoundaryData(error).stack as string).length).toBeLessThanOrEqual(4000);
  });
});
