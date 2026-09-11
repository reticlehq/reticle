import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActionType } from '@reticlehq/core';
import { executeAction, refs } from '@reticlehq/browser';

describe('React controlled inputs integration with check/uncheck actions', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  function ControlledCheckbox(): ReturnType<typeof createElement> {
    const [checked, setChecked] = useState(false);
    return createElement(
      'label',
      null,
      createElement('input', {
        type: 'checkbox',
        'data-testid': 'agree-box',
        checked,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setChecked(e.target.checked),
      }),
      createElement('span', { 'data-testid': 'status-text' }, checked ? 'AGREED' : 'NOT_AGREED'),
    );
  }

  it('updates React controlled component state and triggers re-render on check and uncheck', async () => {
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(ControlledCheckbox)));
      const input = container.querySelector<HTMLInputElement>('[data-testid="agree-box"]');
      const status = container.querySelector<HTMLElement>('[data-testid="status-text"]');
      expect(input).not.toBeNull();
      expect(status).not.toBeNull();
      if (!input || !status) return;

      expect(input.checked).toBe(false);
      expect(status.textContent).toBe('NOT_AGREED');

      await act(async () => {
        await executeAction(refs.refFor(input), ActionType.CHECK, {});
      });

      expect(input.checked).toBe(true);
      expect(status.textContent, 'React component re-rendered with new state').toBe('AGREED');

      await act(async () => {
        await executeAction(refs.refFor(input), ActionType.UNCHECK, {});
      });

      expect(input.checked).toBe(false);
      expect(status.textContent, 'React component re-rendered back to unchecked state').toBe(
        'NOT_AGREED',
      );
    } finally {
      act(() => root.unmount());
    }
  });

  function ControlledRadioGroup(): ReturnType<typeof createElement> {
    const [selected, setSelected] = useState('a');
    return createElement(
      'div',
      null,
      createElement('input', {
        type: 'radio',
        name: 'group',
        value: 'a',
        'data-testid': 'radio-a',
        checked: 'a' === selected,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSelected(e.target.value),
      }),
      createElement('input', {
        type: 'radio',
        name: 'group',
        value: 'b',
        'data-testid': 'radio-b',
        checked: 'b' === selected,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => setSelected(e.target.value),
      }),

      createElement('span', { 'data-testid': 'selected-val' }, selected),
    );
  }

  it('correctly transitions React controlled radio group selection', async () => {
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(ControlledRadioGroup)));
      const radioA = container.querySelector<HTMLInputElement>('[data-testid="radio-a"]');
      const radioB = container.querySelector<HTMLInputElement>('[data-testid="radio-b"]');
      const span = container.querySelector<HTMLElement>('[data-testid="selected-val"]');
      expect(radioA).not.toBeNull();
      expect(radioB).not.toBeNull();
      expect(span).not.toBeNull();
      if (!radioA || !radioB || !span) return;

      expect(radioA.checked).toBe(true);
      expect(radioB.checked).toBe(false);
      expect(span.textContent).toBe('a');

      await act(async () => {
        await executeAction(refs.refFor(radioB), ActionType.CHECK, {});
      });

      expect(radioB.checked).toBe(true);
      expect(radioA.checked).toBe(false);
      expect(span.textContent, 'React state updated from radio change').toBe('b');
    } finally {
      act(() => root.unmount());
    }
  });

  it('is idempotent on already-checked React controlled component', async () => {
    const root = createRoot(container);
    try {
      act(() => root.render(createElement(ControlledCheckbox)));
      const input = container.querySelector<HTMLInputElement>('[data-testid="agree-box"]');
      const status = container.querySelector<HTMLElement>('[data-testid="status-text"]');
      expect(input).not.toBeNull();
      expect(status).not.toBeNull();
      if (!input || !status) return;

      // First check: transitions false -> true
      await act(async () => {
        await executeAction(refs.refFor(input), ActionType.CHECK, {});
      });
      expect(input.checked).toBe(true);
      expect(status.textContent).toBe('AGREED');

      // Second check: already checked, remains checked and agreed
      await act(async () => {
        await executeAction(refs.refFor(input), ActionType.CHECK, {});
      });
      expect(input.checked, 'subsequent check must remain checked').toBe(true);
      expect(status.textContent, 'component state remains AGREED').toBe('AGREED');
    } finally {
      act(() => root.unmount());
    }
  });
});
