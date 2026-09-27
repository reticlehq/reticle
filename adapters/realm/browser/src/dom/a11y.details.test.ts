import { ElementState } from '@reticlehq/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { isVisible } from './a11y.js';
import { matchQuery, runQuery } from './query.js';

const HTML_TAG = {
  details: 'details',
  heading: 'h2',
  host: 'div',
  slot: 'slot',
  span: 'span',
  summary: 'summary',
} as const;

const SUMMARY_SLOT_NAME = 'summary-content';
const SUMMARY_TEXT = 'Connection status and setup';
const HEADING_TEXT = 'Connected to staging';
const HEADING_ROLE = 'heading';
const SHADOW_ROOT_MODE_OPEN = 'open';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const SVG_TAG = 'svg';

function createDetailsFixture(): {
  details: HTMLDetailsElement;
  summaryText: HTMLSpanElement;
  heading: HTMLHeadingElement;
} {
  const details = document.createElement(HTML_TAG.details);
  const summary = document.createElement(HTML_TAG.summary);
  const summaryText = document.createElement(HTML_TAG.span);
  summaryText.textContent = SUMMARY_TEXT;
  summary.append(summaryText);

  const heading = document.createElement(HTML_TAG.heading);
  heading.textContent = HEADING_TEXT;
  details.append(summary, heading);
  document.body.append(details);

  return { details, summaryText, heading };
}

describe('visibility inside native details', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps the summary and its descendants visible while details is closed', () => {
    const { summaryText, heading } = createDetailsFixture();

    expect(isVisible(summaryText)).toBe(true);
    expect(isVisible(heading)).toBe(false);
  });

  it('reports collapsed content hidden and matches it as visible only after expansion', () => {
    const { details, heading } = createDetailsFixture();
    const query = { role: HEADING_ROLE, name: HEADING_TEXT };

    expect(runQuery(query).elements[0]?.visible).toBe(false);
    expect(matchQuery(query, ElementState.VISIBLE).count).toBe(0);

    details.open = true;

    expect(runQuery(query).elements[0]?.visible).toBe(true);
    expect(matchQuery(query, ElementState.VISIBLE).count).toBe(1);
    expect(isVisible(heading)).toBe(true);
  });

  it('applies collapsed visibility through shadow slots to light-DOM content', () => {
    const host = document.createElement(HTML_TAG.host);
    const shadowRoot = host.attachShadow({ mode: SHADOW_ROOT_MODE_OPEN });
    const details = document.createElement(HTML_TAG.details);
    const summary = document.createElement(HTML_TAG.summary);
    const summarySlot = document.createElement(HTML_TAG.slot);
    summarySlot.name = SUMMARY_SLOT_NAME;
    summary.append(summarySlot);

    const bodySlot = document.createElement(HTML_TAG.slot);
    details.append(summary, bodySlot);
    shadowRoot.append(details);

    const summaryText = document.createElement(HTML_TAG.span);
    summaryText.slot = SUMMARY_SLOT_NAME;
    summaryText.textContent = SUMMARY_TEXT;
    const heading = document.createElement(HTML_TAG.heading);
    heading.textContent = HEADING_TEXT;
    host.append(summaryText, heading);
    document.body.append(host);

    expect(summaryText.assignedSlot).not.toBeNull();
    expect(heading.assignedSlot).not.toBeNull();
    expect(isVisible(summaryText)).toBe(true);
    expect(isVisible(heading)).toBe(false);

    details.open = true;
    expect(isVisible(heading)).toBe(true);
  });

  it('does not apply HTML details behavior to same-named SVG elements', () => {
    const svg = document.createElementNS(SVG_NAMESPACE, SVG_TAG);
    const details = document.createElementNS(SVG_NAMESPACE, HTML_TAG.details);
    const heading = document.createElementNS(SVG_NAMESPACE, HTML_TAG.heading);
    details.append(heading);
    svg.append(details);
    document.body.append(svg);

    expect(isVisible(heading)).toBe(true);
  });
});
