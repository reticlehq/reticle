# Motion & Micro-interactions Guide

Motion in product UI serves three purposes. If an animation doesn't do at least one—remove it.

1. **Feedback** — "I pressed this and it worked"
2. **Continuity** — "Here's where the element went and where it came from"
3. **Hierarchy** — "Look here, this is important"

---

## 0. Context First

Before adding motion, answer these questions:

| Question | Why It Matters |
|----------|----------------|
| **Product UI or marketing?** | Product: subtle, fast, functional. Marketing: more expressive allowed. |
| **How often is this triggered?** | High-frequency (hover, typing): faster. Low-frequency (modal open): can be slower. |
| **Does this help or distract?** | If you can't justify the animation's purpose—don't add it. |

**Hard rule:**

> When in doubt — shorter, subtler, or none. Motion that doesn't serve function is noise.

---

## 1. The Motion Pyramid

From essential to risky. Start at Level 1, add higher levels only when justified.

### Level 1: Micro Feedback (Most Important)

- Hover, press, focus states
- Toggles, checkboxes, radio buttons
- Inline validation indicators

**Goal:** Feeling of responsiveness without noticeable animation.

### Level 2: State Transitions

- Expand/collapse (accordions, details)
- Tab switches
- Modal, drawer, popover appearance

**Goal:** "Movement" instead of "teleportation."

### Level 3: Layout Continuity

- Elements resize/reposition while maintaining context
- Reorder, filter chips, drag-and-drop
- List item add/remove

**Goal:** Cognitive economy—less "what just happened?"

### Level 4: Expressive (Rare in Product)

- Hero animations, illustrations
- Onboarding sequences
- Marketing pages

**Risk zone:** Easily becomes noise. Use sparingly in product UI.

---

## 2. Timing That Actually Works

Forget "500ms for everything." Use purpose-based categories.

### Duration Reference

| Category | Duration | Examples |
|----------|----------|----------|
| **Instant** | 90–150ms | Hover, press, toggle, focus |
| **State change** | 160–240ms | Accordion, tabs, small panels |
| **Page/large** | 240–360ms | Modal, drawer, route transition |
| **Complex** | 360–500ms | Large layout reflow (rare, optimize if possible) |

### Practical Preset (Copy-Paste Ready)

```css
:root {
  --duration-fast: 120ms;
  --duration-default: 200ms;
  --duration-slow: 320ms;
}
```

### Rules

- **Smaller distance/amplitude → shorter duration**
- **Higher frequency action → shorter duration**
- **500ms+ in product UI almost always feels slow**
- **If users do it 100x/day, make it instant**

---

## 3. Easing: Native Feel Without Cringe

### Basic Principle

| Action | Easing | Why |
|--------|--------|-----|
| **Enter** (appear) | ease-out | Fast start, soft landing |
| **Exit** (disappear) | ease-in | Soft start, fast exit |
| **State change** | ease-in-out | Smooth both ways |

### CSS Tokens

```css
:root {
  --ease-out: cubic-bezier(0.0, 0.0, 0.2, 1);    /* Enter */
  --ease-in: cubic-bezier(0.4, 0.0, 1, 1);       /* Exit */
  --ease-in-out: cubic-bezier(0.4, 0.0, 0.2, 1); /* Change */
  
  /* Alternative: slightly more "alive" */
  --ease-emphasized: cubic-bezier(0.2, 0.0, 0, 1);
}
```

### When to Use Spring

Spring physics work better for:
- Drag, swipe, gesture responses
- Small "bounce" feedback (use sparingly)
- Elements that feel physical

**Critical:** Spring must decay quickly. No prolonged "jello" effect.

```js
// Framer Motion / Motion example
{ type: "spring", stiffness: 400, damping: 30 }  // Snappy
{ type: "spring", stiffness: 200, damping: 20 }  // Smooth
```

---

## 4. Micro-interactions That Work

Maximum effect, minimum risk.

### Buttons and Controls

| State | Animation | Duration |
|-------|-----------|----------|
| **Hover** | Background color shift | 120ms |
| **Press** | `scale: 0.98` | 90–120ms |
| **Focus** | Ring/outline appears | 120ms |
| **Disabled** | No animation, just visual degradation | — |
| **Loading** | Clear state indicator, not just spinner | — |

```css
.button {
  transition: background-color 120ms var(--ease-out),
              transform 90ms var(--ease-out);
}
.button:hover {
  background-color: var(--primary-hover);
}
.button:active {
  transform: scale(0.98);
}
```

### Inputs

| State | Animation | Notes |
|-------|-----------|-------|
| **Focus** | Border/underline highlight | No layout shift |
| **Error** | Light shake on submit only | Short (200ms), not on every keystroke |
| **Success** | Subtle checkmark or color | Don't overdo it |

### Lists and Tables

| Action | Animation | Notes |
|--------|-----------|-------|
| **Add row** | Fade in + slide 4–8px | 200ms |
| **Remove row** | Fade out + collapse | 180ms |
| **Reorder** | Layout animation | Only if performant |

```css
.list-item-enter {
  opacity: 0;
  transform: translateY(-8px);
}
.list-item-enter-active {
  opacity: 1;
  transform: translateY(0);
  transition: all 200ms var(--ease-out);
}
```

### Modals and Drawers

| Element | Enter | Exit |
|---------|-------|------|
| **Overlay** | Fade 200ms | Fade 150ms |
| **Modal** | Fade + scale from 0.95 | Fade + scale to 0.95 |
| **Drawer** | Slide from edge | Slide to edge |

```css
.modal {
  opacity: 0;
  transform: scale(0.95);
  transition: opacity 200ms var(--ease-out),
              transform 200ms var(--ease-out);
}
.modal.open {
  opacity: 1;
  transform: scale(1);
}
```

---

## 5. Motion Tokens for Design Systems

Define these to prevent chaos across your team.

### Minimum Token Set

```css
:root {
  /* Durations */
  --duration-fast: 120ms;
  --duration-default: 200ms;
  --duration-slow: 320ms;
  
  /* Easings */
  --ease-out: cubic-bezier(0.0, 0.0, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0.0, 1, 1);
  --ease-in-out: cubic-bezier(0.4, 0.0, 0.2, 1);
  
  /* Distances (for micro slides) */
  --motion-distance-sm: 4px;
  --motion-distance-md: 8px;
  --motion-distance-lg: 16px;
}
```

### Component Mapping

| Component | Duration | Easing |
|-----------|----------|--------|
| Hover/press | `--duration-fast` | `--ease-out` |
| Accordion/tabs | `--duration-default` | `--ease-in-out` |
| Modal/drawer | `--duration-slow` | `--ease-out` (enter), `--ease-in` (exit) |
| Tooltip | `--duration-fast` | `--ease-out` |

---

## 6. Reduced Motion: Not Optional

Always provide a `prefers-reduced-motion` variant.

### What to Change

| Full Motion | Reduced Motion |
|-------------|----------------|
| Slide + fade | Fade only |
| Scale + fade | Fade only |
| Spring bounce | Instant or short tween |
| Parallax | Remove entirely |
| Auto-playing loops | Pause or remove |

### Implementation

```css
/* Default: full motion */
.modal {
  transform: scale(0.95);
  opacity: 0;
  transition: transform 200ms var(--ease-out),
              opacity 200ms var(--ease-out);
}

/* Reduced motion: fade only */
@media (prefers-reduced-motion: reduce) {
  .modal {
    transform: none;
    transition: opacity 150ms var(--ease-out);
  }
}
```

### CSS Shortcut

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 7. Libraries and Tools

### For Web/SaaS (React/Next)

| Library | Best For | Notes |
|---------|----------|-------|
| **CSS transitions** | Micro feedback, simple states | Best performance, no dependencies |
| **Motion / Framer Motion** | Layout animations, springs, variants | Go-to for React projects |
| **Web Animations API** | Native, no dependencies | When minimalism is priority |

### For Complex Scenarios

| Library | Best For | Notes |
|---------|----------|-------|
| **GSAP** | Complex timelines, marketing | Heavy but powerful |
| **Rive** | Interactive illustrations, icons | Great for empty states, onboarding |
| **Lottie** | Illustrative animations | Watch file size and export quality |

**For most SaaS products:** CSS + Motion is sufficient.

---

## 8. Anti-Patterns

Things that instantly make motion feel cheap:

### Red Flags

- ❌ **300–600ms on hover/buttons** — feels sluggish
- ❌ **Linear easing** — robotic, unnatural
- ❌ **Everything animates at once** — no attention hierarchy
- ❌ **Infinite loops in product screens** — distracting
- ❌ **Inconsistent timings** — 200ms here, 400ms there, chaos
- ❌ **Large movements without reduced-motion** — accessibility fail
- ❌ **Bounce/spring that doesn't settle** — "jello" effect
- ❌ **Animation for animation's sake** — if you can't justify it, remove it

### Critical: Never Use `transition: all`

```css
/* ❌ NEVER — unpredictable, causes layout thrashing */
.button {
  transition: all 200ms ease;
}

/* ✅ ALWAYS — explicit properties only */
.button {
  transition: background-color 120ms var(--ease-out),
              transform 90ms var(--ease-out);
}
```

**Why `transition: all` is dangerous:**
- Animates properties you didn't intend (width, height, padding)
- Causes layout recalculations on every frame
- Performance killer, especially on low-end devices
- Makes debugging animation issues nearly impossible

### Transform Origin

For scale/rotate animations, set `transform-origin` explicitly:

```css
/* Dropdown appearing from top-right corner */
.dropdown {
  transform-origin: top right;
  transform: scale(0.95);
  opacity: 0;
}
.dropdown.open {
  transform: scale(1);
  opacity: 1;
}
```

**Common origins:**
- Modals: `center` (default)
- Dropdowns: `top left` or `top right` (where trigger is)
- Tooltips: edge closest to trigger
- Buttons: `center` for press effect

### SVG Animation

Transforms on SVG elements behave differently. Wrap in `<g>`:

```css
/* ❌ Won't work as expected */
svg path {
  transform: rotate(45deg);
}

/* ✅ Works correctly */
svg g.icon-wrapper {
  transform-box: fill-box;
  transform-origin: center;
  transform: rotate(45deg);
}
```

### Animations Must Be Interruptible

User input should be able to interrupt any animation mid-flight:

```css
/* Animation responds to new state immediately */
.panel {
  transition: transform 300ms var(--ease-out);
}
/* No need for animation-fill-mode: forwards or delays that block interaction */
```

### Quick Test

1. Does this animation serve feedback, continuity, or hierarchy?
2. Is the duration appropriate for the action frequency?
3. Does it have proper easing (not linear)?
4. Is there a reduced-motion variant?
5. Would removing it hurt the UX?

If you answered "no" to #1 or #5—remove the animation.

---

## 9. Pre-Ship Checklist

- [ ] **Hover/press states:** 90–150ms with ease-out
- [ ] **State transitions:** 160–240ms with ease-in-out
- [ ] **Modals/drawers:** 240–360ms with proper enter/exit easing
- [ ] **All motion uses tokens**, not random values
- [ ] **Reduced motion variant** tested and working
- [ ] **No linear easing** anywhere
- [ ] **Nothing exceeds 500ms** in product UI
- [ ] **Every animation has a purpose** (feedback/continuity/hierarchy)
- [ ] **Consistent across similar components**
- [ ] **Performance tested** on slower devices
- [ ] **No `transition: all`** — list properties explicitly
- [ ] **`transform-origin`** set for scale/rotate animations
- [ ] **Animations interruptible** — respond to user input mid-animation

---

## Appendix: Complete Token System

Reference implementation:

```css
:root {
  /* ===== DURATIONS ===== */
  --duration-instant: 0ms;
  --duration-fast: 120ms;
  --duration-default: 200ms;
  --duration-slow: 320ms;
  --duration-slower: 400ms;
  
  /* ===== EASINGS ===== */
  /* Standard (Material-inspired) */
  --ease-out: cubic-bezier(0.0, 0.0, 0.2, 1);
  --ease-in: cubic-bezier(0.4, 0.0, 1, 1);
  --ease-in-out: cubic-bezier(0.4, 0.0, 0.2, 1);
  
  /* Emphasized (more "alive") */
  --ease-emphasized: cubic-bezier(0.2, 0.0, 0, 1);
  --ease-emphasized-decel: cubic-bezier(0.05, 0.7, 0.1, 1);
  
  /* ===== DISTANCES ===== */
  --motion-distance-xs: 2px;
  --motion-distance-sm: 4px;
  --motion-distance-md: 8px;
  --motion-distance-lg: 16px;
  --motion-distance-xl: 24px;
  
  /* ===== SPRINGS (for JS libraries) ===== */
  /* Use in Framer Motion / Motion */
  /* Snappy: { stiffness: 400, damping: 30 } */
  /* Smooth: { stiffness: 200, damping: 20 } */
  /* Bouncy: { stiffness: 300, damping: 15 } — use sparingly */
}

/* ===== REDUCED MOTION ===== */
@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast: 0ms;
    --duration-default: 0ms;
    --duration-slow: 100ms;
    --duration-slower: 100ms;
    --motion-distance-sm: 0px;
    --motion-distance-md: 0px;
    --motion-distance-lg: 0px;
  }
}
```

---

## Resources

- **Material Design Motion** — Easing, duration, tokens, systematic approach
- **Apple HIG Motion** — Platform conventions, reduced motion criteria
- **Motion.dev / Framer Motion docs** — Spring/tween/layout animations
- **Web Animations API (MDN)** — Native browser animation capabilities

---

*Motion is restraint. Fast, purposeful, accessible. If you can't explain why it's there—remove it.*
