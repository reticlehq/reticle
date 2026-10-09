/**
 * Who Run Harness acts as: a few people worth being, or the person's own words.
 *
 * A blank "Act as…" box asked a first-time user to invent a persona before they had seen one. The
 * presets are the ones that find different bugs; each sends `Label: hint` as the persona, exactly
 * where the free text went, so the platform and the saved flow's intent read the same sentence.
 */
import { PERSONA_KEY_PREFIX } from '@/storage-keys.js';
import { esc } from './chrome/presenter-safe-html.js';

export const CUSTOM_PERSONA = 'custom';

export const PERSONAS = [
  {
    id: 'first-time',
    label: 'First-time visitor',
    hint: 'starts from the first page, reads the labels and follows the obvious path',
  },
  {
    id: 'power-user',
    label: 'Returning power user',
    hint: 'goes straight to the main task, takes shortcuts and repeats it quickly',
  },
  {
    id: 'phone',
    label: 'On a phone, slow connection',
    hint: 'small-screen habits: taps, waits on loading, retries when nothing seems to happen',
  },
  {
    id: 'keyboard',
    label: 'Keyboard only',
    hint: 'Tab, Enter and Escape only: focus order, traps and controls it cannot reach',
  },
  {
    id: 'careless',
    label: 'Careless user (bad and unexpected input)',
    hint: 'empty fields, wrong formats, very long text, double submits, going back mid-flow',
  },
  {
    id: 'admin',
    label: 'Admin / settings',
    hint: 'changes settings and permissions, then checks they stick after a reload',
  },
] as const;

export const DEFAULT_PERSONA = PERSONAS[0].id;

const TEXT = {
  LABEL: 'As',
  CUSTOM: 'Custom…',
  CUSTOM_SHORT: 'Custom',
  CUSTOM_HINT: 'Describe who to be or what to try, in your own words.',
  CUSTOM_PLACEHOLDER: 'e.g. a first-time shopper paying by card',
} as const;

export const PERSONA_PICK_ID = 'reticle-harness-persona-pick';
const PERSONA_TEXT_ID = 'reticle-harness-persona';

function presetOf(pick: string): (typeof PERSONAS)[number] | undefined {
  return PERSONAS.find((persona) => persona.id === pick);
}

/** What Run Harness sends for this pick: the preset's sentence, or the trimmed custom words. */
export function personaText(pick: string, custom: string): string | undefined {
  const preset = presetOf(pick);
  if (preset !== undefined) return `${preset.label}: ${preset.hint}`;
  const own = custom.trim();
  return 0 === own.length ? undefined : own;
}

/** The preset's label, "Custom" for the person's own words. */
export function personaLabel(pick: string): string {
  return presetOf(pick)?.label ?? TEXT.CUSTOM_SHORT;
}

/**
 * "As [First-time visitor ▾]": the picker, labelled. Each preset's hint of what it tries is its
 * tooltip and the select's accessible description, not a line of its own: the row stays one row.
 */
export function personaPickHtml(pick: string): string {
  const options = [
    ...PERSONAS.map((p) => ({ id: p.id, label: p.label, hint: p.hint })),
    { id: CUSTOM_PERSONA, label: TEXT.CUSTOM, hint: TEXT.CUSTOM_HINT },
  ]
    .map(
      (o) =>
        `<option value="${o.id}" title="${esc(o.hint)}"${o.id === pick ? ' selected' : ''}>${esc(o.label)}</option>`,
    )
    .join('');
  const hint = esc(presetOf(pick)?.hint ?? TEXT.CUSTOM_HINT);
  return (
    `<label class="reticle-harness-as" for="${PERSONA_PICK_ID}">${TEXT.LABEL}</label>` +
    `<select id="${PERSONA_PICK_ID}" data-reticle-harness-persona-pick class="reticle-harness-persona" title="${hint}" aria-describedby="${PERSONA_PICK_ID}-hint">${options}</select>` +
    `<span id="${PERSONA_PICK_ID}-hint" class="reticle-sr">${hint}</span>`
  );
}

/** The person's own words, offered only once Custom is picked. */
export function personaCustomHtml(pick: string): string {
  return CUSTOM_PERSONA === pick
    ? `<input type="text" id="${PERSONA_TEXT_ID}" data-reticle-harness-persona class="reticle-harness-persona" aria-label="${TEXT.CUSTOM_HINT}" placeholder="${TEXT.CUSTOM_PLACEHOLDER}">`
    : '';
}

/** A pick the picker offers, or undefined for anything else (an old or hand-edited value). */
export function knownPick(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && (CUSTOM_PERSONA === value || presetOf(value))
    ? value
    : undefined;
}

/** The last pick for this project, or the default; storage that throws or is empty is the default. */
export function readPick(projectId: string | undefined): string {
  try {
    return (
      knownPick(localStorage.getItem(`${PERSONA_KEY_PREFIX}${projectId ?? ''}`)) ?? DEFAULT_PERSONA
    );
  } catch {
    return DEFAULT_PERSONA;
  }
}

export function savePick(projectId: string | undefined, pick: string): void {
  try {
    localStorage.setItem(`${PERSONA_KEY_PREFIX}${projectId ?? ''}`, pick);
  } catch {
    /* without storage the picker still works; it just forgets */
  }
}
