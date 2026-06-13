import { describe, it, expect } from 'vitest';
import { identify } from './index.js';

function PayButton(): null {
  return null;
}

describe('react adapter fiber walk', () => {
  it('resolves component stack and source file from the fiber tree', () => {
    const el = document.createElement('button');
    const componentFiber = {
      return: null,
      type: PayButton,
      elementType: PayButton,
      _debugSource: { fileName: 'src/checkout/PayButton.tsx', lineNumber: 24, columnNumber: 6 },
    };
    const hostFiber = { return: componentFiber, type: 'button', elementType: 'button' };
    (el as unknown as Record<string, unknown>)['__reactFiber$test'] = hostFiber;

    const info = identify(el);
    expect(info).not.toBeNull();
    expect(info?.componentStack).toContain('PayButton');
    expect(info?.source?.file).toBe('src/checkout/PayButton.tsx');
    expect(info?.source?.line).toBe(24);
  });

  it('returns null for a non-React element', () => {
    const el = document.createElement('div');
    expect(identify(el)).toBeNull();
  });
});
