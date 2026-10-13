import { describe, expect, it } from 'vitest';
import { morphHtml } from './presenter-morph.js';

describe('morphHtml keeps the controls it repaints', () => {
  it('keeps a button whose text and attributes change, and drops what is gone', () => {
    const host = document.createElement('div');
    morphHtml(host, '<span>Harness</span><button data-run>Run</button><i>x</i>');
    const button = host.querySelector('button');
    morphHtml(host, '<span>Harness · 3 steps</span><button data-stop disabled>Stop</button>');
    expect(host.querySelector('button')).toBe(button);
    expect(button?.textContent).toBe('Stop');
    expect(button?.hasAttribute('data-run')).toBe(false);
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(host.querySelector('i')).toBeNull();
    expect(host.innerHTML).toBe(
      '<span>Harness · 3 steps</span><button data-stop="" disabled="">Stop</button>',
    );
  });

  it('replaces a node that changed kind', () => {
    const host = document.createElement('div');
    morphHtml(host, '<select></select><button>Run</button>');
    const button = host.querySelector('button');
    morphHtml(host, '<span>Driving</span><button>Stop</button>');
    expect(host.querySelector('select')).toBeNull();
    expect(host.querySelector('span')?.textContent).toBe('Driving');
    expect(host.querySelector('button')).toBe(button);
  });
});
