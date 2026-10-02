import { afterEach, describe, expect, it } from 'vitest';
import { getAccessibleName, isVisible } from './a11y.js';
import { installShadowRegistry } from './shadow-registry.js';

describe('name from content for roles that allow it', () => {
  // A segmented filter written as `<button role="radio">held</button>` is an extremely ordinary
  // design-system control. `radio` was missing from the name-from-content set, so six filters on a
  // shipments console reported as six nameless radios and `by: role` + name could not address any of
  // them — the agent had to fall back to a testid the app has no reason to carry.
  it.each(['radio', 'checkbox', 'row', 'tooltip', 'button', 'tab'])(
    'names a %s from its text content',
    (role) => {
      const el = document.createElement('div');
      el.setAttribute('role', role);
      el.textContent = 'held';
      expect(getAccessibleName(el)).toBe('held');
    },
  );

  it('still prefers an explicit aria-label over content', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'radio');
    el.setAttribute('aria-label', 'status: held');
    el.textContent = 'held';
    expect(getAccessibleName(el)).toBe('status: held');
  });
});

describe('aria-hidden decoration inside a label', () => {
  /**
   * The name we REPORT must be a name the agent can then MATCH on.
   *
   * `by: role` matching must use this same computed name. A previous split implementation excluded
   * `aria-hidden` subtrees while this function read the label's raw `textContent`, so MUI's
   * required-field marker (`<span aria-hidden="true"> *</span>`) made us report `"Username *"` for
   * a field that was only addressable as `"Username"`.
   *
   * Measured on the react-admin demo login form: `reticle_query` reported the textbox as
   * `name: "Username *"`, and querying that exact string back returned ZERO elements while
   * `"Username"` returned one. An agent that reads a name out of a snapshot and uses it — the whole
   * point of reporting names — got nothing, on a pattern every Material UI form emits.
   */
  it('ignores an aria-hidden required marker, matching the spec-computed name', () => {
    const label = document.createElement('label');
    label.htmlFor = 'u';
    label.append('Username');
    const marker = document.createElement('span');
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = ' *';
    label.append(marker);
    const input = document.createElement('input');
    input.id = 'u';
    document.body.append(label, input);
    try {
      expect(getAccessibleName(input)).toBe('Username');
    } finally {
      label.remove();
      input.remove();
    }
  });

  /**
   * The path that actually runs for Material UI, and the one the first fix missed.
   *
   * `getAccessibleName` tries `aria-labelledby` BEFORE the `labels` collection, and MUI's TextField
   * links its label that way — so patching the labels path alone changed nothing on the real app, and
   * the fix looked applied while the symptom persisted. Verified against the installed MUI source:
   * `FormLabel` renders its required marker as `<span aria-hidden="true">{'\u2009'}*</span>`.
   */
  it('ignores an aria-hidden marker reached through aria-labelledby', () => {
    const label = document.createElement('label');
    label.id = 'lbl';
    label.append('Username');
    const marker = document.createElement('span');
    marker.setAttribute('aria-hidden', 'true');
    marker.textContent = '\u2009*';
    label.append(marker);
    const input = document.createElement('input');
    input.setAttribute('aria-labelledby', 'lbl');
    document.body.append(label, input);
    try {
      expect(getAccessibleName(input)).toBe('Username');
    } finally {
      label.remove();
      input.remove();
    }
  });

  it('ignores aria-hidden content when naming from content too', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'button');
    el.append('Save');
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ' ✓';
    el.append(icon);
    expect(getAccessibleName(el)).toBe('Save');
  });
});

describe('a closed native <details> hides what the summary does not contain', () => {
  /**
   * Reported from the field on more than one stack: a control inside a CLOSED `<details>` was
   * reported `visible`, so the click that expands the `<summary>` returned `already_true` /
   * no-fault, and the verdict was lost rather than the reading merely being wrong. A closed
   * `<details>` unrenders its content without setting `display:none` on it, and in some engines
   * the content keeps a layout box, so a check built from aria-hidden/[hidden]/display/
   * visibility/opacity alone cannot see it. Only the first `<summary>` child stays on screen.
   */
  it('reports the summary visible and the content hidden while closed', () => {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Connection status and setup';
    const heading = document.createElement('h2');
    heading.textContent = 'Connected';
    details.append(summary, heading);
    document.body.append(details);
    try {
      expect(isVisible(summary)).toBe(true); // the disclosure control itself still renders
      expect(isVisible(heading)).toBe(false);
      expect(isVisible(details)).toBe(true);
    } finally {
      details.remove();
    }
  });

  it('keeps content without a summary child hidden while closed', () => {
    const details = document.createElement('details');
    const heading = document.createElement('h2');
    heading.textContent = 'Connected';
    details.append(heading);
    document.body.append(details);
    try {
      expect(isVisible(heading)).toBe(false);
    } finally {
      details.remove();
    }
  });

  it('reports the content visible once the details is open', () => {
    const details = document.createElement('details');
    details.setAttribute('open', '');
    const summary = document.createElement('summary');
    summary.textContent = 'Connection status and setup';
    const heading = document.createElement('h2');
    heading.textContent = 'Connected';
    details.append(summary, heading);
    document.body.append(details);
    try {
      expect(isVisible(heading)).toBe(true);
    } finally {
      details.remove();
    }
  });

  it('keeps content hidden when a nesting ancestor is the closed details', () => {
    // An inner details that is itself OPEN still renders nothing when its outer details is
    // closed and the inner one sits in the outer's content rather than its summary.
    const outer = document.createElement('details');
    const outerSummary = document.createElement('summary');
    outerSummary.textContent = 'outer';
    const inner = document.createElement('details');
    inner.setAttribute('open', '');
    const innerSummary = document.createElement('summary');
    innerSummary.textContent = 'inner';
    const heading = document.createElement('h2');
    heading.textContent = 'Connected';
    inner.append(innerSummary, heading);
    outer.append(outerSummary, inner);
    document.body.append(outer);
    try {
      expect(isVisible(innerSummary)).toBe(false);
      expect(isVisible(heading)).toBe(false);
    } finally {
      outer.remove();
    }
  });
});

describe('visibility composes across a shadow boundary', () => {
  /**
   * Query candidates include shadow content — open roots always, captured closed roots too
   * (`embeddedRootsUnder` in query.ts). `parentElement` is null at the top of a shadow tree
   * (a ShadowRoot is a DocumentFragment), so a walk that stops there never sees the host, and
   * whatever hides the host — a closed `<details>`, `display:none`, `aria-hidden` — hides
   * nothing. A web component inside a collapsed disclosure would read `visible` again.
   */
  function mountHostedControl(): { details: HTMLDetailsElement; button: HTMLElement } {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Connection status and setup';
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.textContent = 'Retry';
    shadow.append(button);
    details.append(summary, host);
    document.body.append(details);
    return { details, button };
  }

  it('hides a shadow control whose host sits inside a closed details', () => {
    const { details, button } = mountHostedControl();
    try {
      expect(isVisible(button)).toBe(false);
    } finally {
      details.remove();
    }
  });

  it('hides a shadow control whose host is not rendered', () => {
    const host = document.createElement('div');
    host.style.display = 'none'; // the own-box signals never reach into the host's shadow tree
    const shadow = host.attachShadow({ mode: 'open' });
    const button = document.createElement('button');
    button.textContent = 'Retry';
    shadow.append(button);
    document.body.append(host);
    try {
      expect(isVisible(button)).toBe(false);
    } finally {
      host.remove();
    }
  });

  it('still reports a shadow control visible when its host chain is', () => {
    const { details, button } = mountHostedControl();
    details.setAttribute('open', '');
    try {
      expect(isVisible(button)).toBe(true);
    } finally {
      details.remove();
    }
  });
});

describe('slotted content inherits visibility from where it is slotted', () => {
  /**
   * A light-DOM child renders at its slot, so a `<details>` around the slot inside the host's shadow
   * root is its ancestor on screen, though never in `parentElement` (#1175). The walk went from the
   * child straight to the host, and the closed disclosure hid nothing.
   */
  function mountSlotted(open: boolean): {
    host: HTMLElement;
    child: HTMLElement;
    kept: HTMLElement;
  } {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML =
      '<details><summary><slot name="label"></slot></summary><slot></slot></details>';
    if (open) shadow.querySelector('details')?.setAttribute('open', '');
    const kept = document.createElement('span');
    kept.slot = 'label';
    kept.textContent = 'Advanced';
    const child = document.createElement('button');
    child.textContent = 'Reset';
    host.append(kept, child);
    document.body.append(host);
    return { host, child, kept };
  }

  it('hides content slotted into a closed details', () => {
    const { host, child } = mountSlotted(false);
    try {
      expect(isVisible(child)).toBe(false);
    } finally {
      host.remove();
    }
  });

  it('keeps content slotted into the summary visible, as a browser does', () => {
    const { host, kept } = mountSlotted(false);
    try {
      expect(isVisible(kept)).toBe(true);
    } finally {
      host.remove();
    }
  });

  it('shows the slotted content once the details is open', () => {
    const { host, child } = mountSlotted(true);
    try {
      expect(isVisible(child)).toBe(true);
    } finally {
      host.remove();
    }
  });
});

describe('slotted into a closed details in a CLOSED shadow root', () => {
  /**
   * `assignedSlot` is null for a closed root by design, so the walk cannot learn the slot from the
   * child. A root the registry captured can still be asked from inside, which is how the closed
   * variant of #1175 is answered; an uncaptured closed root stays unreadable, as it always was.
   */
  let uninstall: (() => void) | undefined;
  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  function mountClosed(): { host: HTMLElement; child: HTMLElement } {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = '<details><summary>More</summary><slot></slot></details>';
    const child = document.createElement('button');
    child.textContent = 'Reset';
    host.append(child);
    document.body.append(host);
    return { host, child };
  }

  it('hides the child when the registry captured the closed root', () => {
    uninstall = installShadowRegistry();
    const { host, child } = mountClosed();
    try {
      expect(isVisible(child)).toBe(false);
    } finally {
      host.remove();
    }
  });
});

describe('a summary is found by its local name, so XHTML reads the same', () => {
  it('keeps a lowercase-tagName summary of a closed details visible', () => {
    const doc = document.implementation.createDocument('http://www.w3.org/1999/xhtml', 'html');
    const body = doc.createElementNS('http://www.w3.org/1999/xhtml', 'body');
    doc.documentElement.append(body);
    const details = doc.createElementNS('http://www.w3.org/1999/xhtml', 'details');
    const summary = doc.createElementNS('http://www.w3.org/1999/xhtml', 'summary');
    summary.textContent = 'More';
    details.append(summary);
    body.append(details);
    expect(summary.tagName).toBe('summary');
    const label = doc.createElementNS('http://www.w3.org/1999/xhtml', 'span');
    summary.append(label);

    expect(isVisible(label)).toBe(true);
  });
});

describe('label for> on a labelable element other than input/textarea/select', () => {
  /**
   * `<button>` is a labelable element (as are `<meter>`, `<output>` and `<progress>`), and a native
   * `<label for>` outranks the button's own content in the name computation. `el.labels` was only
   * read inside the input/textarea/select guard, so a select-style trigger built as
   * `<button role="combobox">` with a `<label for>` fell through to naming from its own text content
   * instead - `{ role: "combobox", name: "…" }` found nothing and targeting had to fall back to refs.
   */
  it("prefers a native label over a button's own content", () => {
    const label = document.createElement('label');
    label.htmlFor = 'plan';
    label.append('Plan');
    const button = document.createElement('button');
    button.id = 'plan';
    button.setAttribute('role', 'combobox');
    button.append('Choose…');
    document.body.append(label, button);
    try {
      expect(getAccessibleName(button)).toBe('Plan');
    } finally {
      label.remove();
      button.remove();
    }
  });

  it('names a plain button from its label', () => {
    const label = document.createElement('label');
    label.htmlFor = 'b';
    label.append('Save draft');
    const button = document.createElement('button');
    button.id = 'b';
    button.append('Save');
    document.body.append(label, button);
    try {
      expect(getAccessibleName(button)).toBe('Save draft');
    } finally {
      label.remove();
      button.remove();
    }
  });

  it.each(['meter', 'output', 'progress'])(
    'names a %s from a native label, not its own content',
    (tag) => {
      const label = document.createElement('label');
      label.htmlFor = 'm';
      label.append('Disk usage');
      const el = document.createElement(tag);
      el.id = 'm';
      document.body.append(label, el);
      try {
        expect(getAccessibleName(el)).toBe('Disk usage');
      } finally {
        label.remove();
        el.remove();
      }
    },
  );
});

describe('the labels read is scoped to labelable elements', () => {
  /**
   * `getAccessibleName` runs over every element a snapshot walks, not only form fields, so it meets
   * arbitrary elements - including custom elements an app defines with its own `labels` property for
   * its own purposes (a tag list, a chart's category labels, ...). A `<div role="radio">` is not
   * labelable per the HTML spec, so this read must never touch `.labels` on it at all: a hostile
   * getter that throws, or a `.labels` that isn't a NodeList, must not break naming for elements this
   * function has no business reading `.labels` from in the first place.
   */
  it('does not throw and falls back to content when a non-labelable element has a hostile labels property', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'radio');
    el.textContent = 'held';
    Object.defineProperty(el, 'labels', {
      configurable: true,
      get() {
        throw new Error('boom');
      },
    });
    expect(() => getAccessibleName(el)).not.toThrow();
    expect(getAccessibleName(el)).toBe('held');
  });
});

describe('adjacent text nodes do not get spurious spaces (#1254)', () => {
  it('concatenates adjacent text nodes without inserting spaces', () => {
    const button = document.createElement('button');
    button.append('Complete All (', '2', ')');
    expect(getAccessibleName(button)).toBe('Complete All (2)');
  });

  it('still separates an image alt from adjacent text', () => {
    const button = document.createElement('button');
    const img = document.createElement('img');
    img.setAttribute('alt', 'Close');
    button.append(img, 'Dialog');
    expect(getAccessibleName(button)).toBe('Close Dialog');
  });

  it('separates text around an inline element', () => {
    const button = document.createElement('button');
    const em = document.createElement('em');
    em.textContent = 'bold';
    button.append('Make ', em, ' text');
    expect(getAccessibleName(button)).toBe('Make bold text');
  });
});

describe('fieldset named by its legend', () => {
  it('names a fieldset from its direct-child legend', () => {
    const fieldset = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'Shipping address';
    fieldset.append(legend, document.createElement('input'));
    expect(getAccessibleName(fieldset)).toBe('Shipping address');
  });

  it('does not pick up a legend nested in a child element', () => {
    const fieldset = document.createElement('fieldset');
    const wrapper = document.createElement('div');
    const legend = document.createElement('legend');
    legend.textContent = 'Nested';
    wrapper.append(legend);
    fieldset.append(wrapper);
    expect(getAccessibleName(fieldset)).toBe('');
  });

  it('still prefers aria-label over the legend', () => {
    const fieldset = document.createElement('fieldset');
    fieldset.setAttribute('aria-label', 'Override');
    const legend = document.createElement('legend');
    legend.textContent = 'Shipping address';
    fieldset.append(legend);
    expect(getAccessibleName(fieldset)).toBe('Override');
  });
});
