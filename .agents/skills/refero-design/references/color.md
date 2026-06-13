# Color Guide

Color is the emotional backbone of UI. Get it wrong and your product looks either amateur or AI-generated. Get it right and everything feels intentional.

---

## 0. Context First

Before touching palettes, answer these questions:

| Question | Why It Matters |
|----------|----------------|
| **Product UI or marketing?** | Product: fewer colors, more neutrals, strict semantics. Marketing: more emotion, gradients, contrast allowed. |
| **Data density?** | Dashboards need muted accents, high text contrast, no "glowing" colors. Content-focused UI can be softer. |
| **Is brand defined?** | No brand: use safe preset, refine later. Existing brand: translate brand color into system tokens, don't paint everything with it. |

**Hard rule:**

> When in doubt — fewer colors, more neutrals, stricter purpose. Restraint beats "colorful."

This single rule eliminates 50% of AI-slop before you start.

---

## 1. Color Space

Why most palettes "break" when you try to extend them.

### The Problem with HSL

HSL is intuitive but poorly represents perceptual brightness. A "50% lightness" yellow looks much brighter than "50% lightness" blue. This makes consistent scales nearly impossible.

### The Solution: OKLCH

OKLCH (or LCH) provides perceptually uniform lightness. Steps from 50→950 actually look even.

**Practical workflow:**
- Generate and adjust palettes in OKLCH
- Store production values as hex
- Keep OKLCH logic as source of truth

```css
/* OKLCH example */
--primary-500: oklch(0.55 0.2 250);  /* Base */
--primary-600: oklch(0.48 0.2 250);  /* Hover */
--primary-700: oklch(0.41 0.2 250);  /* Active */
```

**For MVP:** You can skip OKLCH. Use curated palettes (Tailwind, Radix, Open Color). But know why they work.

---

## 2. Palette Structure

You need 4 layers, not "30 beautiful colors."

### 2.1 Neutrals (Most Important)

Neutrals are 70–90% of your UI. This is where you win or lose.

**Requirements:**
- 10-12 steps: 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950
- Slight character (warm or cool), not colorful circus
- Consistent across light and dark themes

**Scale reference:**

| Step | Use | Example |
|------|-----|---------|
| 50 | Near-white backgrounds | `#fafafa` |
| 100-200 | Surfaces, cards | `#f5f5f5`, `#e5e5e5` |
| 300-400 | Borders, dividers | `#d4d4d4`, `#a3a3a3` |
| 500 | Placeholder text | `#737373` |
| 600-700 | Secondary text | `#525252`, `#404040` |
| 800-900 | Primary text | `#262626`, `#171717` |
| 950 | Near-black | `#0a0a0a` |

**Hard rules:**
- Never use pure `#000` on white as body text
- Don't make text gray "for breathing room" — spacing creates breathing room, not faded text

### 2.2 Primary Accent

One brand color. It should:
- Have good contrast on both white and dark backgrounds
- Have a full scale (50–950), not just one hex
- Be used sparingly and purposefully

**Typical usage:**

| Step | Use |
|------|-----|
| 50-100 | Tinted backgrounds |
| 500-600 | Default state |
| 600-700 | Hover state |
| 700-800 | Active/pressed state |

### 2.3 Semantic Colors

Usually 3-4:
- **Success** — Green (confirmations, completion)
- **Warning** — Amber/Yellow (attention needed)
- **Danger** — Red (errors, destructive actions)
- **Info** — Blue (neutral information) — optional

**Important:** Semantics work through pairs, not single colors.

```css
/* Each semantic needs: */
--success: #16a34a;           /* Icon, text accent */
--success-bg: #f0fdf4;        /* Background */
--success-border: #86efac;    /* Border */
--on-success: #ffffff;        /* Text on solid success */
```

### 2.4 Effects (Only If Needed)

- Gradients
- Glows
- Illustration tints

**Rule:** In product UI, effects should be rare and localized. Save drama for marketing.

---

## 3. The 60/30/10 Rule

Distribution that works for any interface:

| Percentage | Elements |
|------------|----------|
| 60-80% | Neutrals (backgrounds, surfaces, borders) |
| 10-20% | Text hierarchy (different gray levels) |
| 5-10% | Accents and semantics |

### Component Color Limit

**Maximum 2 colors per component.**

If a button has brand gradient + colored border + colored shadow + colored text, it's almost always garbage.

### State Changes: Structure, Not Circus

Hover and Active should be:
- Slightly darker/lighter
- Slightly more contrast
- Subtle shadow enhancement

**Don't** repaint every state with a new random color.

```css
/* Good */
.button {
  background: var(--primary);
}
.button:hover {
  background: var(--primary-hover);  /* Just darker */
}

/* Bad */
.button:hover {
  background: linear-gradient(135deg, #ff6b6b, #feca57);
  box-shadow: 0 0 20px #ff6b6b;
}
```

---

## 4. Contrast and Readability

Not about checking boxes — about actual readability.

### Minimum Requirements

| Text Type | WCAG AA Ratio |
|-----------|---------------|
| Body text (≤16px) | 4.5:1 |
| Large text (18px+ bold, 24px+ regular) | 3:1 |
| UI components, icons | 3:1 |

### Common Failures

1. **Secondary text too pale** — The #1 issue. If it looks fine on your Retina display at noon, it fails on cheap monitors at 9pm.

2. **Text on tinted backgrounds** — "Almost readable" text on colored backgrounds fails in real conditions (tired eyes, ambient light, older monitors).

### Practical Check

- Test secondary text on multiple devices
- If you squint and text disappears, it's too light
- Ask: "Would my parents read this easily?"

---

## 5. Light and Dark Themes

### The Wrong Way

Inverting colors mechanically: white → black, black → white.

Result: eye-burning contrast, amateur look.

### The Right Way

**Dark theme gets its own neutral scale.**

```css
/* Light */
:root {
  --bg: #ffffff;
  --surface: #f7f7f7;
  --text: #0b0b0b;
  --text-muted: #5f6368;
}

/* Dark — NOT just inverted */
[data-theme="dark"] {
  --bg: #0f0f0f;          /* Not #000 */
  --surface: #1a1a1a;
  --text: #f0f0f0;        /* Not #fff */
  --text-muted: #a1a1a1;
}
```

### Dark Theme Elevation

In dark UI, surfaces and layers communicate through:
- Slightly lighter backgrounds for elevated elements
- Subtle borders (1px, low contrast)
- Very soft shadows or no shadows at all

```css
[data-theme="dark"] {
  --surface-elevated: #242424;  /* Lighter than base */
  --border: rgba(255, 255, 255, 0.1);
}
```

### Dark Mode: Technical Implementation

Browser-level settings that most developers miss:

```html
<!-- In <head> — tells browser UI elements to use dark mode -->
<meta name="color-scheme" content="light dark">

<!-- Theme color for browser chrome, PWA, mobile address bar -->
<meta name="theme-color" content="#0f0f0f" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
```

```css
/* On <html> — fixes scrollbars, form controls, system dialogs */
:root {
  color-scheme: light;
}
[data-theme="dark"] {
  color-scheme: dark;
}
```

**Why this matters:**
- Without `color-scheme: dark`, scrollbars stay light gray on dark backgrounds
- Form inputs (`<input>`, `<select>`, `<textarea>`) get wrong default colors
- System dialogs and autofill appear broken

**Native `<select>` fix for dark mode (Windows issue):**

```css
[data-theme="dark"] select {
  background-color: var(--surface-2);
  color: var(--text);
}
```

---

## 6. Naming Tokens

**Never name tokens by color. Name by purpose.**

### Bad

```css
--blue: #2563eb;
--light-blue: #eff6ff;
--dark-blue: #1e40af;
```

### Good

```css
--primary: #2563eb;
--primary-tint: #eff6ff;
--primary-active: #1e40af;
```

### Minimum Token Set

```css
:root {
  /* Surfaces */
  --bg: #ffffff;
  --surface-1: #ffffff;
  --surface-2: #f7f7f7;

  /* Text */
  --text: #0b0b0b;
  --text-muted: #5f6368;
  --text-subtle: #7a7f85;

  /* Borders */
  --border: #e6e6e6;
  --border-strong: #d1d1d1;

  /* Primary */
  --primary: #2563eb;
  --on-primary: #ffffff;
  --primary-hover: #1d4ed8;
  --primary-active: #1e40af;
  --primary-tint: #eff6ff;

  /* Semantic */
  --success: #16a34a;
  --warning: #f59e0b;
  --danger: #ef4444;
}
```

**Key:** Components should work from tokens, not hardcoded hex values.

---

## 7. Building a Palette from Scratch

When there's no brand yet:

### Step 1: Choose Neutral Character

Decide warm or cool. This affects the entire feel.

```css
/* Cool (tech, precision) */
--neutral-100: #f4f4f5;

/* Warm (friendly, premium) */
--neutral-100: #f5f4f2;
```

### Step 2: Choose One Primary

Requirements:
- Works on white background
- Works on dark background
- Works in buttons, links, badges
- "Strong" but not fluorescent

**Test:** Put your primary in a button, a text link, a badge. All three should feel right.

### Step 3: Generate Scale

Use OKLCH or curated palette generators:
- [Tailwind CSS Colors](https://tailwindcss.com/docs/customizing-colors)
- [Radix Colors](https://www.radix-ui.com/colors)
- [Open Color](https://yeun.github.io/open-color/)

### Step 4: Add Semantics

Choose semantic colors that don't clash with primary.

| Primary | Avoid for Success |
|---------|-------------------|
| Blue | Blue (use green) |
| Green | Yellow-green (use teal) |
| Red | Red-orange (use green) |

---

## 8. Gradients

Gradients are allowed when:
- They support brand identity
- They don't break readability
- They're localized (hero, illustration, small highlight)

### Rules

1. **Gradient is never the only way to make something visible** — If removing the gradient makes the element invisible, redesign.

2. **Subtle > dramatic** — Direction and angle matter more than color variety.

3. **Text on gradients** — Ensure contrast works across the entire gradient, not just the start.

```css
/* Acceptable */
.hero-badge {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
}

/* Problematic */
.card {
  background: linear-gradient(90deg, 
    #ff6b6b, #feca57, #48dbfb, #ff9ff3);
}
```

---

## 9. Anti-Patterns

Structural problems that reveal unintentional design:

### 🚨 THE #1 AI SLOP INDICATOR: INDIGO/VIOLET

**This deserves its own section because it's THAT important.**

Every LLM, every AI code generator, every design tool defaults to indigo/violet (`#6366f1`, `#8b5cf6`, or similar). This has become the universal fingerprint of AI-generated design.

**Before using any purple-family color, ask:**
1. Does the brand explicitly require purple?
2. Did research references use purple (and why)?
3. Is there a semantic reason (not just "looks modern")?
4. Would a senior designer question this choice?

**If you can't answer YES to at least one of these—choose a different color.**

Safe alternatives when you need an accent:
- Blue (`#2563eb`) — trust, stability, professional
- Teal (`#0d9488`) — fresh, modern, distinctive
- Green (`#16a34a`) — growth, success, natural
- Orange (`#ea580c`) — energy, action, warmth
- Brand-specific color from research

**The rule:** Indigo is BANNED unless explicitly justified by brand requirements.

### Other Red Flags

- **Multiple competing accents** — One primary. Others should be clearly secondary or semantic
- **Random hex in components** — Should use tokens
- **Pure black on white** — Use near-black (#0b0b0b)
- **Every state is a new color** — Hover/active should be predictable shifts
- **Dark theme = inverted** — Needs separate neutrals

### Quick Test

1. Is your primary color indigo/violet? (If yes, justify it or change it)
2. Can you justify your primary color choice with research?
3. How many accent colors? (Should be 1-2)
4. Are all colors from tokens, not random hex?

→ Full anti-AI-slop guide: [anti-ai-slop.md](anti-ai-slop.md)

---

## 10. Pre-Ship Checklist

- [ ] **One primary accent**, not 3 "hero colors"
- [ ] **Neutrals are 70-90%** of the interface
- [ ] **Text readable everywhere**, secondary text not pale
- [ ] **Hover/Active states predictable** and calm
- [ ] **Tokens named by purpose** (bg, text, border, primary)
- [ ] **Dark theme is separate**, not inverted
- [ ] **Semantics don't clash** with primary
- [ ] **No random hex** in components — all from tokens
- [ ] **Contrast passes** WCAG AA (4.5:1 body, 3:1 large)
- [ ] **Gradients are rare** and localized
- [ ] **`color-scheme`** set on `<html>` for dark mode (fixes scrollbars, inputs)
- [ ] **`<meta name="theme-color">`** matches page background

---

## Appendix: Complete Token System

Reference implementation with all tokens:

```css
:root {
  /* Neutrals (cool variant) */
  --neutral-50: #fafafa;
  --neutral-100: #f5f5f5;
  --neutral-200: #e5e5e5;
  --neutral-300: #d4d4d4;
  --neutral-400: #a3a3a3;
  --neutral-500: #737373;
  --neutral-600: #525252;
  --neutral-700: #404040;
  --neutral-800: #262626;
  --neutral-900: #171717;
  --neutral-950: #0a0a0a;

  /* Surfaces */
  --bg: var(--neutral-50);
  --surface-1: #ffffff;
  --surface-2: var(--neutral-100);
  --surface-3: var(--neutral-200);

  /* Text */
  --text: var(--neutral-900);
  --text-muted: var(--neutral-600);
  --text-subtle: var(--neutral-500);
  --text-disabled: var(--neutral-400);

  /* Borders */
  --border: var(--neutral-200);
  --border-strong: var(--neutral-300);

  /* Primary (blue) */
  --primary-50: #eff6ff;
  --primary-100: #dbeafe;
  --primary-200: #bfdbfe;
  --primary-500: #3b82f6;
  --primary-600: #2563eb;
  --primary-700: #1d4ed8;
  --primary-800: #1e40af;
  --primary-900: #1e3a8a;

  --primary: var(--primary-600);
  --primary-hover: var(--primary-700);
  --primary-active: var(--primary-800);
  --primary-tint: var(--primary-50);
  --on-primary: #ffffff;

  /* Semantic */
  --success: #16a34a;
  --success-bg: #f0fdf4;
  --warning: #f59e0b;
  --warning-bg: #fffbeb;
  --danger: #ef4444;
  --danger-bg: #fef2f2;
  --info: #0ea5e9;
  --info-bg: #f0f9ff;
}

/* Dark theme */
[data-theme="dark"] {
  --bg: #0f0f0f;
  --surface-1: #171717;
  --surface-2: #1f1f1f;
  --surface-3: #262626;

  --text: #f5f5f5;
  --text-muted: #a3a3a3;
  --text-subtle: #737373;

  --border: rgba(255, 255, 255, 0.1);
  --border-strong: rgba(255, 255, 255, 0.15);

  --primary: #60a5fa;
  --primary-hover: #3b82f6;
  --primary-active: #2563eb;
  --primary-tint: rgba(59, 130, 246, 0.15);
  --on-primary: #0f0f0f;

  --success-bg: rgba(22, 163, 74, 0.15);
  --warning-bg: rgba(245, 158, 11, 0.15);
  --danger-bg: rgba(239, 68, 68, 0.15);
  --info-bg: rgba(14, 165, 233, 0.15);
}
```

---

*Color is restraint. Neutrals are 90% of the work. One accent, used purposefully, beats five competing for attention.*
