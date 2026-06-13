import { describe, it, expect, vi, afterEach } from 'vitest';
import { EventType } from '@iris/protocol';
import { createCommandRegistry } from './commands.js';
import { executeAction } from './actions.js';
import { installScroll } from './observers/scroll.js';
import { installOverlay } from './overlay.js';
import { refs } from './refs.js';

describe('drag', () => {
  it('fires a pointer/mouse drag from source to target', () => {
    document.body.innerHTML = '<div id="a">A</div><div id="b">B</div>';
    const a = document.getElementById('a') as HTMLElement;
    const b = document.getElementById('b') as HTMLElement;
    const down = vi.fn();
    const up = vi.fn();
    a.addEventListener('mousedown', down);
    b.addEventListener('mouseup', up);
    executeAction(refs.refFor(a), 'drag', { toRef: refs.refFor(b) });
    expect(down).toHaveBeenCalled();
    expect(up).toHaveBeenCalled();
  });
});

describe('scroll observer', () => {
  it('emits a scroll position event', () => {
    const emit = vi.fn();
    const stop = installScroll(emit);
    window.dispatchEvent(new Event('scroll'));
    const scrollEvents = emit.mock.calls.filter((c) => c[0] === EventType.SCROLL_POSITION);
    expect(scrollEvents.length).toBeGreaterThan(0);
    stop();
  });
});

describe('webmcp passthrough', () => {
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>)['modelContext'];
  });

  it('calls a navigator.modelContext tool via the act command', async () => {
    const callTool = vi.fn((name: string) => Promise.resolve({ called: name }));
    (navigator as unknown as Record<string, unknown>)['modelContext'] = { callTool };
    const reg = createCommandRegistry();
    const handler = reg.get('act');
    if (handler === undefined) throw new Error('no act handler');
    const result = await handler({
      action: 'webmcp',
      args: { tool: 'search', params: { q: 'x' } },
    });
    expect(callTool).toHaveBeenCalledWith('search', { q: 'x' });
    expect(result).toEqual({ called: 'search' });
  });
});

describe('dev overlay', () => {
  it('mounts and unmounts a status chip', () => {
    const handle = installOverlay();
    expect(document.querySelector('[data-iris-overlay]')).not.toBeNull();
    handle.update({ connected: true, events: 3 });
    handle.destroy();
    expect(document.querySelector('[data-iris-overlay]')).toBeNull();
  });
});
