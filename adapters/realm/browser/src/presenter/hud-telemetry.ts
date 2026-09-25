import { HUD_KEYED_ATTRS, isHudControl } from '@reticlehq/core/hud';
import { HudPanel, HudToggle, HudView, type HudUseData } from '@reticlehq/core';
import { isReticleUi } from '@/dom/dom-ignore.js';
import { nativeSetTimeout } from '@/timers/native/native-timers.js';
import { CHAT_ATTR, MIN_ATTR, REPORT_ATTR, SETTINGS_ATTR } from './presenter-config.js';

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

function viewOf(root: Element): { view: HudView; panel: HudPanel } {
  if ('1' === root.getAttribute(MIN_ATTR)) return { view: HudView.BUBBLE, panel: HudPanel.NONE };
  if ('1' === root.getAttribute(SETTINGS_ATTR)) {
    return { view: HudView.EXPANDED, panel: HudPanel.SETTINGS };
  }
  if ('1' === root.getAttribute(REPORT_ATTR)) {
    return { view: HudView.EXPANDED, panel: HudPanel.REPORT };
  }
  if ('1' === root.getAttribute(CHAT_ATTR)) return { view: HudView.EXPANDED, panel: HudPanel.CHAT };
  return { view: HudView.COLLAPSED, panel: HudPanel.NONE };
}

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
  doc.addEventListener('click', onPress, true);
  const observer = new MutationObserver(onChange);
  observer.observe(root, {
    attributes: true,
    attributeFilter: [MIN_ATTR, CHAT_ATTR, SETTINGS_ATTR, REPORT_ATTR],
  });
  onChange();
  return () => {
    doc.removeEventListener('click', onPress, true);
    observer.disconnect();
  };
}
