# Icons & Glyphs Guide

In product UI, treat icons as typography — functional, not decorative.

---

## Two Contexts

| Context | Style | Rule |
|---------|-------|------|
| **Product UI** | Clean outline or solid, one consistent set | Predictable, scalable, themeable |
| **Marketing** | Duotone, gradients, illustrative allowed | Never leaks into product |

---

## Icon Sizing

**Canvas** = the bounding box icons are designed within. Most libraries use 24×24px as base, but this is convention, not law.

**Display sizes** depend on context:
- Small (16px): inline with body text, table cells, dense UI
- Medium (20–24px): buttons, nav items, form inputs
- Large (28–32px): feature cards, empty states, marketing

**Stroke weight** varies by library and style:
- Thinner (1.5px): lighter feel, works better at larger sizes
- Standard (2px): common default in Lucide, Heroicons
- Thicker (2.5px+): bolder presence, better at small sizes

**Round vs square caps/joins:** Round feels friendlier, modern. Square feels more technical, precise. Match your product's tone.

**Key principle:** Pick one library or define your own spec. Consistency matters more than specific values.

---

## Optical Corrections

What separates "adequate" from "premium."

**Centering:** Geometric center ≠ visual center.
- Play triangles → shift right 0.5–1px
- Chevrons/arrows → shift toward point
- **Test:** Put icon in a circle. Looks centered? If not, adjust.

**Weight:** Different shapes have different visual mass at same stroke.
- Circles appear lighter than squares
- Diagonals appear thinner than horizontals
- **Aim for equal visual mass**, not equal measurements

---

## Style Consistency

One language per product. No exceptions.

| Style | Best For |
|-------|----------|
| **Outline** | Dense UIs, data-heavy products |
| **Solid** | Consumer apps, clear actions |
| **Variable glyphs** | Design systems (SF Symbols, Material Symbols) |

**Don'ts:**
- ❌ Outline in nav + solid in buttons + duotone in cards
- ❌ Mixing libraries (Lucide + Heroicons = collage)
- ❌ Custom icons that ignore the system's grid/stroke

---

## Icon + Text Pairing

Starting point — adjust based on visual testing:

| Text Size | Icon Size |
|-----------|-----------|
| 14–16px | 16px |
| 16–18px | 18–20px |
| Headings | 20–24px |

**Alignment:** Icons need `align-items: center` + often 0.5–1px manual tweak.

**Weight harmony:** Semibold text + thin icon = "from different systems." Match weights or use solid.

---

## Color

**Default:** `currentColor` — inherits text color, syncs with themes automatically.

**Semantic:** Red (error), green (success), amber (warning) — only for status, never decoration.

**Contrast:** Meaningful icons need **3:1 ratio** (WCAG non-text). Applies to icon buttons, toggles, status indicators.

---

## Accessibility

| Type | Requirement |
|------|-------------|
| Action icons | `aria-label` on button, or visible text nearby |
| Decorative icons | `aria-hidden="true"` |
| Icon buttons | Hit area: 44×44px on touch, 32×32px on desktop (visual can be smaller) |

---

## Pre-Ship Checklist

- [ ] **50% scale:** Icons readable when zoomed out?
- [ ] **Grayscale:** States clear without color?
- [ ] **Dark theme:** Outline icons don't disappear?
- [ ] **Table rows:** Icons don't overpower text?
- [ ] **Contrast:** Icon buttons meet 3:1?
- [ ] **Touch targets:** 44px+ hit area?
- [ ] **Consistency:** Same style everywhere?

---

## Libraries

### For Product UI (SVG-based)

| Library | Style | When to Use |
|---------|-------|-------------|
| **Lucide** | Outline only | SaaS default. Clean, consistent, 24×24/2px stroke. |
| **Heroicons** | Outline + Solid | Tailwind projects. Two variants per icon. |
| **Phosphor** | 6 weights | Need weight flexibility without variable fonts. |

### Variable Glyph Systems

Best when icons must match text weight dynamically.

**Material Symbols (Web)**

```css
/* Include from Google Fonts, then: */
.icon {
  font-family: 'Material Symbols Outlined';
  font-variation-settings: 
    'FILL' 0,      /* 0 = outline, 1 = solid */
    'wght' 500,    /* match your text weight */
    'opsz' 24;     /* optical size: 20, 24, 40, 48 */
}
```

- `wght`: Sync with text (400, 500, 600)
- `opsz`: Increase for smaller icons (better clarity)
- `FILL`: Toggle outline/solid per icon

**SF Symbols (Apple/Native)**

- Automatically matches San Francisco font weight
- Scale axis for emphasis (small/medium/large)
- Use in SwiftUI/UIKit, not web

### When to Use What

| Scenario | Choice |
|----------|--------|
| Web SaaS, quick start | Lucide |
| Tailwind project | Heroicons |
| Need weight sync with text | Material Symbols |
| Apple native app | SF Symbols |
| Multiple weights, no variable fonts | Phosphor |

---

*Icons are typography. Consistent, optical, accessible. If it doesn't read instantly—simplify.*
