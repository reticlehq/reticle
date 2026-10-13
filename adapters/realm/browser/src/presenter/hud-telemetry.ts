import { HUD_KEYED_ATTRS, isHudControl } from '@reticlehq/core/hud';
import { HudPanel, HudPromptSurface, HudToggle, HudView, type HudUseData } from '@reticlehq/core';
import { isReticleUi } from '@/dom/dom-ignore.js';
import { nativeSetTimeout } from '@/timers/native/native-timers.js';
import { CHAT_ATTR, MIN_ATTR, REPORT_ATTR, SETTINGS_ATTR } from './presenter-config.js';
import { CAROUSEL_SLIDE_ATTR } from './carousel/carousel.js';
import { ACCOUNT_MENU_ATTR, ACCOUNT_SIGNIN_ATTR, TEAM_SAVE_ATTR } from './presenter-account.js';
import { HARNESS_LINK_ATTR } from './presenter-harness-row.js';
import { RAIL_SIGNIN_ATTR } from './presenter-frame.js';

/**
 * Report how a person uses the HUD, as control names only.
 *
 * One capture-phase listener on the document names every press from the control's own
 * `data-reticle-*` attribute, so a control added later is counted without anybody remembering to
 * wire it, and the test that walks the rendered HUD fails if it has no name core accepts. One
 * observer on the HUD root reports where the HUD sits and which panel shows. Nothing here reads
 * text, a flow name or a URL.
 */

const PREFIX = 'data-reticle-';
/** Set on the root while the Flows or Notes page covers the Agent Log. */
const PAGE_OPEN_ATTR = 'data-reticle-page-open';
const TOGGLE_ROLES = new Set(['switch', 'checkbox']);

/** The control id an element is named by, or undefined when it is not one of the HUD's controls. */
export function controlIdOf(el: Element): string | undefined {
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith(PREFIX)) continue;
    const name = attr.name.slice(PREFIX.length);
    const id = (HUD_KEYED_ATTRS as readonly string[]).includes(name)
      ? `${name}.${attr.value}`
      : name;
    if (isHudControl(id)) return id;
  }
  return undefined;
}

function controlOf(path: readonly EventTarget[]): Element | undefined {
  for (const node of path) {
    if (!(node instanceof Element)) continue;
    if (controlIdOf(node) !== undefined) return node;
  }
  return undefined;
}

/** Where the HUD sits, with an open account menu counted as its own page over whatever is under it. */
function viewOf(root: Element): { view: HudView; panel: HudPanel } {
  const page = pageOf(root);
  if (HudView.BUBBLE === page.view) return page;
  return null === root.querySelector(`[${ACCOUNT_MENU_ATTR}]:not([hidden])`)
    ? page
    : { view: page.view, panel: HudPanel.ACCOUNT };
}

function pageOf(root: Element): { view: HudView; panel: HudPanel } {
  if ('1' === root.getAttribute(MIN_ATTR)) return { view: HudView.BUBBLE, panel: HudPanel.NONE };
  if ('1' === root.getAttribute(SETTINGS_ATTR)) {
    return { view: HudView.EXPANDED, panel: HudPanel.SETTINGS };
  }
  if ('1' === root.getAttribute(REPORT_ATTR)) {
    return { view: HudView.EXPANDED, panel: HudPanel.REPORT };
  }
  // The Flows and Notes pages open over the Agent Log, with or without its own attribute set.
  const page = root.getAttribute(PAGE_OPEN_ATTR);
  if ('flows' === page) return { view: HudView.EXPANDED, panel: HudPanel.FLOWS };
  if ('annotations' === page) return { view: HudView.EXPANDED, panel: HudPanel.NOTES };
  if ('harness' === page) return { view: HudView.EXPANDED, panel: HudPanel.HARNESS };
  if ('1' === root.getAttribute(CHAT_ATTR)) return { view: HudView.EXPANDED, panel: HudPanel.CHAT };
  return { view: HudView.COLLAPSED, panel: HudPanel.NONE };
}

/**
 * The sign-in and link asks the HUD can show, each with where it has to be to be seen: the rail sits
 * under every open page, the Harness page's controls only count on that page, and the header's
 * "Save runs for your team" whenever the HUD is more than a bubble.
 */
const PROMPTS: readonly {
  surface: HudPromptSurface;
  selector: string;
  shown: (at: { view: HudView; panel: HudPanel }) => boolean;
}[] = [
  {
    surface: HudPromptSurface.RAIL,
    selector: `[${RAIL_SIGNIN_ATTR}]`,
    shown: (at) => HudView.EXPANDED === at.view,
  },
  {
    surface: HudPromptSurface.HARNESS,
    selector: `[data-reticle-page-panel="harness"] :is([${ACCOUNT_SIGNIN_ATTR}],[${HARNESS_LINK_ATTR}])`,
    shown: (at) => HudPanel.HARNESS === at.panel,
  },
  {
    surface: HudPromptSurface.HEADER,
    selector: `[${TEAM_SAVE_ATTR}]`,
    shown: (at) => HudView.BUBBLE !== at.view,
  },
];

const visible = (el: Element): boolean => null === el.closest('[hidden]');

/** Start reporting. Returns the teardown. */
export function installHudTelemetry(
  doc: Document,
  root: Element,
  report: (use: HudUseData) => void,
): () => void {
  const send = (use: HudUseData): void => {
    try {
      report(use);
    } catch {
      /* a metric may never change behaviour */
    }
  };
  const onPress = (event: Event): void => {
    const el = controlOf(event.composedPath());
    if (el === undefined || !isReticleUi(el)) return;
    const control = controlIdOf(el);
    if (control === undefined) return;
    if (!TOGGLE_ROLES.has(el.getAttribute('role') ?? '')) {
      send({ control });
      return;
    }
    // Capture runs before the control's own handler flips it, so read the state it landed in.
    nativeSetTimeout(() => {
      const on = 'true' === el.getAttribute('aria-checked');
      send({ control, toggle: on ? HudToggle.ON : HudToggle.OFF });
    }, 0);
  };
  let last = '';
  const onChange = (): void => {
    const now = viewOf(root);
    const key = `${now.view}/${now.panel}`;
    if (key === last) return;
    last = key;
    send(now);
  };
  // A rail slide counts when it becomes the visible one while the Agent Log is open: an impression,
  // named by the slide's id. The same slide shown again in a row is not a second impression.
  let lastSlide = '';
  const onSlide = (): void => {
    if (HudPanel.CHAT !== viewOf(root).panel) return;
    const shown = root.querySelector(`[${CAROUSEL_SLIDE_ATTR}]:not([hidden])`);
    const slide = shown?.getAttribute(CAROUSEL_SLIDE_ATTR) ?? '';
    if (0 === slide.length || slide === lastSlide) return;
    lastSlide = slide;
    send({ slide });
  };
  // Each ask once per page load; the daemon keeps its own once-per-tab on top.
  const prompted = new Set<HudPromptSurface>();
  const onPrompt = (): void => {
    const at = viewOf(root);
    for (const prompt of PROMPTS) {
      if (prompted.has(prompt.surface) || !prompt.shown(at)) continue;
      const el = root.querySelector(prompt.selector);
      if (null === el || !visible(el)) continue;
      prompted.add(prompt.surface);
      send({ prompt: prompt.surface });
    }
  };
  // Inside the HUD: a slide turning, the account menu opening, a prompt painted in or unhidden.
  const inside = new MutationObserver(() => {
    onSlide();
    onChange();
    onPrompt();
  });
  inside.observe(root, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-active', 'hidden'],
  });
  doc.addEventListener('click', onPress, true);
  const observer = new MutationObserver((records) => {
    onChange();
    if (0 < records.length) onSlide();
    onPrompt();
  });
  observer.observe(root, {
    attributes: true,
    attributeFilter: [MIN_ATTR, CHAT_ATTR, SETTINGS_ATTR, REPORT_ATTR, PAGE_OPEN_ATTR],
  });
  onChange();
  onPrompt();
  return () => {
    doc.removeEventListener('click', onPress, true);
    observer.disconnect();
    inside.disconnect();
  };
}
