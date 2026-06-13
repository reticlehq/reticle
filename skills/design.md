# skills/design.md — Design Tokens & UI

**Open when:** building any UI — the demo dashboard or the Iris dev overlay.

## Single source of truth

All design values live in `apps/demo/src/design/tokens.ts`: `Colors`, `Typography`,
`Spacing` (4px base), `Radius`, `Shadow`. Each is `as const`.

- **Never hardcode a hex, px, or font** in a component. Import from `tokens.ts`.
- A font-size or color change is a one-line edit in `tokens.ts` and cascades everywhere.
- When the Iris **dev overlay** (M4) gets its own package, it ships its own tokens file with
  the same shape, or imports a shared `@iris/tokens`. Same rule: one source of truth.

## Accessibility is a product feature here, not a nicety

Iris's whole snapshot model is the **accessibility tree** (`skills/architecture.md`,
`plan/04`). So the demo (and any UI we ship) must be exemplary: real `role`s, `aria-*`
states, labels on every control, `aria-selected` on tabs, `role="dialog"` + `aria-modal`
on modals. Good a11y → better snapshots → the product demos itself. The demo's tabs/list
already model this; keep that bar.

## Refero reference

Design references go through `/refero <niche>` (e.g. `/refero "developer tools dashboard"`).
Extract palette, type scale, spacing rhythm, shadow system → fold into `tokens.ts`. Do not
copy pixels; extract the system.
