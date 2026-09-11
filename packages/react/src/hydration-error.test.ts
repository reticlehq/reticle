import { describe, it, expect } from 'vitest';
import { buildHydrationErrorData, isHydrationMismatch } from './hydration-error.js';

describe('isHydrationMismatch', () => {
  it('recognizes React 19 hydration-mismatch messages', () => {
    expect(
      isHydrationMismatch(new Error('Hydration failed because the server rendered HTML...')),
    ).toBe(true);
    expect(isHydrationMismatch(new Error('Text content does not match server-rendered HTML'))).toBe(
      true,
    );
    expect(
      isHydrationMismatch(new Error('There was an error while hydrating this Suspense boundary')),
    ).toBe(true);
  });

  it('recognizes minified hydration error codes (#418/#423/#425)', () => {
    expect(
      isHydrationMismatch(
        new Error('Minified React error #418; visit https://react.dev/errors/418'),
      ),
    ).toBe(true);
    expect(isHydrationMismatch(new Error('Minified React error #423'))).toBe(true);
    expect(isHydrationMismatch(new Error('Minified React error #425'))).toBe(true);
  });

  it('does NOT flag an unrelated recoverable error', () => {
    expect(isHydrationMismatch(new Error('Minified React error #300'))).toBe(false);
    expect(isHydrationMismatch(new Error('some other recoverable render error'))).toBe(false);
    expect(isHydrationMismatch('a string was thrown')).toBe(false);
  });
});

describe('buildHydrationErrorData', () => {
  it('shapes a hydration error into message + capped stacks', () => {
    const error = new Error('Hydration failed because the server rendered HTML');
    const data = buildHydrationErrorData(error, { componentStack: '\n    at Nav\n    at App' });
    expect(data.message).toContain('Hydration failed');
    expect(data.stack).toContain('Hydration failed');
    expect(data.componentStack).toContain('at Nav');
  });

  it('caps a very long stack', () => {
    const error = new Error('Hydration failed');
    error.stack = 'x'.repeat(9000);
    expect((buildHydrationErrorData(error).stack as string).length).toBeLessThanOrEqual(4000);
  });
});
