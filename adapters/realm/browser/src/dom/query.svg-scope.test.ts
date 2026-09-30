/**
 * An SVG element is a scope, like any other element (#1122).
 *
 * A floor plan whose rooms are `<a href>` inside an `<svg>`: `look` lists each room as a link with
 * a ref, and the action layer can click it. The scope resolver alone still demanded an HTMLElement,
 * so `{ scope: "svg a[href='/rooms/3']", self: true }` and a scope given as that room's ref both
 * came back as a MISSING scope on a page that plainly has it.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { ActionType, QueryBy } from '@reticlehq/core';
import { executeAction } from '@/actions/actions.js';
import { runQuery } from './query.js';

beforeEach(() => {
  document.body.innerHTML = `
    <svg id="plan" viewBox="0 0 30 10">
      <a href="/rooms/2"><rect width="10" height="10"/></a>
      <a href="/rooms/3"><rect x="10" width="10" height="10"/><title>Kitchen</title></a>
    </svg>`;
});

describe('scoping to an SVG element', () => {
  it('a CSS scope on an SVG link resolves, and self returns it', () => {
    const result = runQuery({ scope: "svg a[href='/rooms/3']", self: true });

    expect(result.scopeMissing).not.toBe(true);
    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]?.ref).toBeDefined();
  });

  it('the ref it hands back is itself a usable scope', () => {
    const ref = runQuery({ scope: "svg a[href='/rooms/3']", self: true }).elements[0]?.ref ?? '';

    const again = runQuery({ scope: ref, self: true });

    expect(again.scopeMissing).not.toBe(true);
    expect(again.elements[0]?.ref).toBe(ref);
  });

  it('a query scoped to the <svg> searches inside it', () => {
    const result = runQuery({ scope: '#plan', by: QueryBy.ROLE, value: 'link' });

    expect(result.scopeMissing).not.toBe(true);
    expect(result.elements.length).toBeGreaterThan(0);
  });

  it('a scope that matches nothing is still reported missing', () => {
    const result = runQuery({ scope: "svg a[href='/rooms/9']", self: true });

    expect(result.scopeMissing).toBe(true);
    expect(result.elements).toEqual([]);
  });
});

describe('the ref query hands out for an SVG link is clickable', () => {
  it("clicking it runs the app's handler", async () => {
    const room = document.querySelector("a[href='/rooms/3']");
    let clicked = 0;
    room?.addEventListener('click', (event) => {
      event.preventDefault();
      clicked += 1;
    });
    const ref = runQuery({ scope: "svg a[href='/rooms/3']", self: true }).elements[0]?.ref ?? '';

    await executeAction(ref, ActionType.CLICK, {});

    expect(clicked).toBe(1);
  });
});
