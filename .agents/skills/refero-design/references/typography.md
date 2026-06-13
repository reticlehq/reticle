# Typography Guide

Typography is 90% of web design. Get it right and everything else falls into place. Get it wrong and no amount of polish will save you.

---

## 0. Context First

Before choosing fonts, answer these questions:

| Question | Why It Matters |
|----------|----------------|
| **Work tool or marketing?** | Work products need neutrality, not personality |
| **Long reading or scanning?** | Changes line-height and density decisions |
| **B2B, B2C, or Dev tool?** | Affects font character and weight choices |

**Default approach:**

> When in doubt — go denser, simpler, and more neutral. Clarity beats decoration in most product interfaces.

This mindset helps avoid over-designed typography in functional contexts. For branding, editorial, or creative products — different rules apply.

---

## 1. The Safe SaaS Preset

Before customizing anything, this works:

```css
:root {
  --font-family: 'Inter', system-ui, sans-serif;
  --text-base: 16px;
  --line-height: 1.55;
  --scale: 1.2;
  
  --font-weight-normal: 400;
  --font-weight-medium: 500;
  --font-weight-semibold: 600;
  
  --max-width: 65ch;
  
  --text-primary: #111;
  --text-secondary: rgba(0,0,0,0.7);
  --text-tertiary: rgba(0,0,0,0.5);
}
```

**If you use this preset as-is, your typography is already good.** Everything below is refinement.

---

## 2. Type Scale

A consistent scale creates visual rhythm. Pick a ratio, stick to it.

### Common Ratios

| Ratio | Multiplier | Best For |
|-------|------------|----------|
| Minor Second | 1.067 | Dense UI, dashboards |
| Major Second | 1.125 | Compact interfaces |
| **Minor Third** | **1.200** | **General purpose — default choice** |
| Major Third | 1.250 | Marketing, editorial |
| Perfect Fourth | 1.333 | Bold, expressive layouts |
| Golden Ratio | 1.618 | Rare: hero sections only |

> **Note:** Golden Ratio is dramatic. Use only for landing page heroes, not general UI.

### Practical Scale (Minor Third × 16px base)

```
11px  — Caption, footnote
13px  — Small text, metadata
16px  — Body (base)
19px  — Large body, lead
23px  — H4
28px  — H3
33px  — H2
40px  — H1
48px  — Display
57px  — Hero
```

### CSS Tokens

```css
:root {
  --text-xs: 0.6875rem;    /* 11px */
  --text-sm: 0.8125rem;    /* 13px */
  --text-base: 1rem;       /* 16px */
  --text-lg: 1.1875rem;    /* 19px */
  --text-xl: 1.4375rem;    /* 23px */
  --text-2xl: 1.75rem;     /* 28px */
  --text-3xl: 2.0625rem;   /* 33px */
  --text-4xl: 2.5rem;      /* 40px */
  --text-5xl: 3rem;        /* 48px */
  --text-6xl: 3.5625rem;   /* 57px */
}
```

**Rule:** Maximum 6-8 sizes in production. More = chaos.

---

## 3. Font Pairing

**Most successful SaaS products use one font family.** Two fonts adds complexity — make sure it's justified.

### The One-Font Rule

```
One font + multiple weights = professional
Two fonts = requires justification
Three fonts = almost never
```

**When you actually need a second font:**
- Marketing/landing pages (not the app itself)
- Content-heavy products (editorial, documentation)
- There's real art direction, not just "looks nice"

If you don't have a strong reason — one font, different weights.

### If You Must Pair

| Strategy | Example |
|----------|---------|
| Serif + Sans | Instrument Serif + Inter |
| Display + System | Cal Sans + system-ui |
| Mono accent | JetBrains Mono (code) + Inter (UI) |

**Pairing rules:**
1. Contrast in structure — serif with sans, not two serifs
2. Similar x-height — letters feel proportional
3. Intentional contrast — mixing eras (Didot + geometric) can work as a deliberate choice, not an accident

### Safe Font Choices by Product Type

| Product | Font |
|---------|------|
| **SaaS / Tech** | Inter, SF Pro, Geist |
| **Finance / Enterprise** | Inter, IBM Plex Sans |
| **Startup** | Inter, DM Sans, Plus Jakarta |
| **Dev tools** | Inter + JetBrains Mono (code) |

---

## 4. Text Color System

Typography in a vacuum doesn't exist. Most "bad" interfaces look bad because of color, not font choice.

### The System

```css
:root {
  --text-primary: #0B0B0B;      /* 100% — headlines, body */
  --text-secondary: rgba(0,0,0,0.65);  /* 65% — descriptions */
  --text-tertiary: rgba(0,0,0,0.45);   /* 45% — metadata, captions */
  --text-disabled: rgba(0,0,0,0.3);    /* 30% — disabled states (rare) */
}
```

### Rules That Actually Work

- **Never pure black** — Use `#0B0B0B` – `#111`, not `#000`
- **Body text minimum** — Never below 60% opacity for readable text
- **Fewer shades, stable usage** — 3-4 text colors max, used consistently
- **Disabled is rare** — If you have lots of disabled text, redesign

### Anti-pattern

> "Let's make the text lighter for an airy feel"

This almost always destroys readability. If it doesn't pass squint test, it's too light.

### Dark Mode Inversion

```css
[data-theme="dark"] {
  --text-primary: #F5F5F5;
  --text-secondary: rgba(255,255,255,0.7);
  --text-tertiary: rgba(255,255,255,0.5);
}
```

---

## 5. Font Weight

Weight creates hierarchy. Use it deliberately.

### Standard Weights

| Weight | Name | Use |
|--------|------|-----|
| 300 | Light | Large display text only |
| 400 | Regular | Body text, descriptions |
| 500 | Medium | UI labels, subtle emphasis |
| 600 | Semibold | Subheadings, buttons |
| 700 | Bold | Headlines, strong emphasis |

### Rules

- **Body text:** Always 400. Never bold entire paragraphs.
- **Headlines:** 400–700 depending on font. Serifs often look better at 400.
- **UI elements:** 500 for labels, 600 for buttons.
- **Small text:** 400 or 500. Light weights (300) become illegible below 16px.

### Weight + Size Relationship

```
Larger size  → can use lighter weight
Smaller size → needs heavier weight

64px heading → 400 weight looks elegant
12px caption → 400 minimum, 500 preferred
```

**Anti-pattern:** Using bold (700) for everything. It flattens hierarchy.

---

## 6. Line Height

Line height (leading) affects readability more than any other property.

### Quick Reference

| Text Type | Line Height | Why |
|-----------|-------------|-----|
| **Body text** | 1.5 – 1.7 | Optimal for reading |
| **Short paragraphs** | 1.4 – 1.5 | Slightly tighter is fine |
| **Headlines** | 1.0 – 1.2 | Tight, impactful |
| **Large display** | 0.9 – 1.1 | Very tight, dramatic |
| **UI text** | 1.2 – 1.4 | Compact but readable |
| **Buttons** | 1 | Single line, centered |

### CSS Tokens

```css
:root {
  --leading-none: 1;
  --leading-tight: 1.15;
  --leading-snug: 1.3;
  --leading-normal: 1.5;
  --leading-relaxed: 1.7;
  --leading-loose: 2;
}
```

### Principles

1. **Longer lines need more leading** — 80+ characters? Use 1.6–1.7
2. **Shorter lines need less** — 40 characters? 1.4 is fine
3. **Headlines are tight** — Multi-line headlines at 1.5 look broken
4. **Sans-serif needs more** — Add 0.1 compared to serif

---

## 7. Vertical Rhythm

AI-slop is almost always exposed by bad spacing between text blocks.

### The Simple Rule

```
Line-height × 0.5 = minimum vertical spacing step
```

### Example

```
Body: 16px / 1.5 → line-height = 24px
Minimum vertical step = 12px
Spacing scale: 12 / 24 / 48
```

### CSS Implementation

```css
:root {
  --space-xs: 12px;   /* 0.5 × line-height */
  --space-sm: 24px;   /* 1 × line-height */
  --space-md: 48px;   /* 2 × line-height */
  --space-lg: 72px;   /* 3 × line-height */
}
```

### Golden Rule

> **Spacing matters more than font size.**

Two designs with the same fonts but different spacing will look like different products. Fix spacing before tweaking fonts.

---

## 8. Letter Spacing (Tracking)

Letter-spacing is one of the most overlooked properties in web typography. It's a polish detail that separates refined interfaces from rough ones.

### Why It Matters

Professional typography isn't just about choosing fonts—it's about the space BETWEEN letters. This single property can make the difference between "looks off" and "looks polished."

**Without proper tracking:**
- ALL CAPS looks cramped and cheap
- Small text becomes harder to read
- Large headlines feel loose and unprofessional
- The entire interface lacks refinement

### Quick Reference

| Text Type | Size | Value | Priority |
|-----------|------|-------|----------|
| **Body text** | 14–18px | `0` | Default OK |
| **Small text** | 11–13px | `0.01em` – `0.02em` | **REQUIRED** |
| **UI labels/buttons** | any | `0.01em` – `0.03em` | **REQUIRED** |
| **ALL CAPS** | any | `0.06em` – `0.10em` | **MANDATORY** |
| **Large headings** | 32px+ | `0` to `-0.02em` | Recommended |
| **Display text** | 48px+ | `-0.02em` to `-0.03em` | Recommended |

### Units

**Always use `em`, never `px`.** Em scales with font size.

### CSS Tokens

```css
:root {
  --tracking-tighter: -0.02em;
  --tracking-tight: -0.01em;
  --tracking-normal: 0em;
  --tracking-wide: 0.015em;
  --tracking-wider: 0.02em;
  --tracking-widest: 0.08em;   /* caps */
}
```

### ALL CAPS Rule

Uppercase text usually benefits from positive letter-spacing. Default behavior for UI text:

```css
/* ❌ WRONG — cramped, amateur, unfinished */
.badge { text-transform: uppercase; }

/* ✅ RIGHT — polished, professional */
.badge {
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
```

### Small Text Rule — Often Forgotten

Text below 14px needs extra tracking for readability:

```css
/* ❌ WRONG — hard to read */
.caption { font-size: 12px; }

/* ✅ RIGHT — improved readability */
.caption {
  font-size: 12px;
  letter-spacing: 0.015em;
}
```

### When to Tighten

Only tighten (negative values) when:
- Size is 32px+
- It's a headline, not body
- Font weight isn't light
- Problem pairs (AV, WA, To) don't collide

### Pre-Implementation Checklist

Before shipping any typography:
- [ ] ALL CAPS elements have `letter-spacing: 0.06em+`
- [ ] Small text (11-13px) has positive tracking
- [ ] UI labels and buttons have tracking
- [ ] Large headings (32px+) have slight negative tracking
- [ ] You didn't just skip letter-spacing entirely

---

## 9. Line Length (Measure)

Optimal reading width prevents eye fatigue.

### Guidelines

| Content | Characters | Pixels (~16px) |
|---------|------------|----------------|
| **Optimal** | 50–75 | 500–700px |
| **Minimum** | 45 | 450px |
| **Maximum** | 85 | 850px |

### Implementation

```css
/* Article content */
.prose {
  max-width: 65ch;  /* ~65 characters */
}

/* Compact UI */
.card-description {
  max-width: 45ch;
}
```

**Anti-pattern:** Full-width paragraphs on desktop. Unreadable above 100 characters.

---

## 10. Text Polish Details

Small details that separate amateur from professional. AI models often miss these.

### Punctuation

| Wrong | Right | Rule |
|-------|-------|------|
| `...` | `…` | Use proper ellipsis character (`&hellip;` or `…`) |
| `"` `"` | `"` `"` | Use curly quotes, not straight quotes |
| `10 MB` | `10&nbsp;MB` | Non-breaking space between number and unit |
| `⌘ K` | `⌘&nbsp;K` | Non-breaking space in keyboard shortcuts |

**Loading states:** Always end with `…` → `"Loading…"`, `"Saving…"`, `"Processing…"`

### Tabular Numbers

When displaying numbers that need to align (tables, prices, stats):

```css
.price,
.table-cell-number,
.stats-value {
  font-variant-numeric: tabular-nums;
}
```

**Why:** Default proportional figures make `111` narrower than `999`. Tabular figures give each digit equal width — essential for columns, counters, prices.

### Text Wrapping for Headings

Prevent orphaned words and awkward final lines in important text. A single word on the
last line of a hero title usually looks accidental, not designed.

```css
h1, h2, h3,
.hero-title,
.card-title {
  text-wrap: balance;  /* Balance short headings/display text */
}

.lead,
.prose p {
  text-wrap: pretty;   /* Improve prose wrapping selectively */
}
```

Use `balance` for short headings, captions, pull quotes, and card titles. Use `pretty`
for lead/body prose when typography matters more than maximum performance. Do not apply
either blindly to nav, buttons, tables, badges, code, form controls, or dense UI labels.

Still inspect the actual breakpoints. If wrapping is still awkward, adjust copy, max-width,
font-size, or line-height instead of trusting CSS alone.

**Browser support:** Modern browsers. Graceful degradation — no harm if unsupported.

### Content Overflow

Text containers must handle long content:

```css
/* Truncate single line */
.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Clamp to N lines */
.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* Break long words (URLs, emails) */
.break-words {
  overflow-wrap: break-word;
  word-break: break-word;
}
```

**Critical for flex layouts:** Flex children need `min-width: 0` to allow text truncation:

```css
/* ❌ Text won't truncate */
.flex-child {
  flex: 1;
}

/* ✅ Text truncates properly */
.flex-child {
  flex: 1;
  min-width: 0;
}
```

---

## 11. Responsive Typography

Font size should respond to viewport, but not linearly.

### Fluid Type (Clamp)

```css
:root {
  /* Min 16px, preferred 2vw, max 20px */
  --text-base: clamp(1rem, 1.5vw + 0.5rem, 1.25rem);
  
  /* Min 32px, scales with viewport, max 56px */
  --text-hero: clamp(2rem, 5vw + 1rem, 3.5rem);
}
```

### Breakpoint Adjustments

```css
:root {
  --text-base: 16px;
  --text-h1: 36px;
}

@media (min-width: 768px) {
  :root {
    --text-h1: 48px;
  }
}

@media (min-width: 1200px) {
  :root {
    --text-h1: 56px;
  }
}
```

### What Changes

| Property | Mobile → Desktop |
|----------|------------------|
| Base font | 16px → 16-18px |
| H1 | 32-36px → 48-64px |
| Line height | Same or slightly less |
| Letter spacing | Same |
| Line length | Shorter → longer |

---

## 12. Performance Typography

Beautiful typography on a slow page is bad typography.

### Requirements

```css
/* Always use font-display: swap */
@font-face {
  font-family: 'Inter';
  font-display: swap;
  src: url('/fonts/inter.woff2') format('woff2');
}
```

### Rules

- **≤2 font families** — One is better
- **≤3 weights per family** — 400, 500, 600 covers 95% of needs
- **Variable fonts preferred** — One file, all weights
- **System stack is fine** — Often better than custom fonts

### System Font Stack

```css
font-family: system-ui, -apple-system, BlinkMacSystemFont, 
             'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
```

This loads instantly, looks native, and is perfectly professional.

### Performance Rule

> If typography is beautiful but the page loads slow — it's bad typography.

---

## 13. AI-Slop Anti-Patterns

Things that instantly reveal AI-generated or amateur design:

### Instant Red Flags

- **10+ text sizes** — Scale should have 6-8 max
- **Gray text on gray background** — Contrast failure
- **Bold in body text** — Flattens hierarchy
- **Centered paragraphs** — Only for short marketing copy
- **Decorative display font without intent** — Should serve brand or product personality, not just decoration
- **ALL CAPS without letter-spacing** — Always needs tracking
- **Inconsistent spacing** — Random gaps between elements
- **Too many font weights** — 400/500/600 is enough

### Quick Test

Look at any interface and count:
1. How many distinct font sizes? (Should be ≤8)
2. How many text colors? (Should be ≤4)
3. How many font weights? (Should be ≤4)

More than these numbers = likely AI-slop or needs editing.

---

## 14. Hierarchy Checklist

Clear hierarchy guides the eye. Test by squinting.

### Visual Weight Stack

```
1. Size        — Biggest impact
2. Weight      — Bold vs regular
3. Color       — Dark vs gray vs muted
4. Case        — Caps for labels
5. Spacing     — Margins create grouping
6. Style       — Italic for emphasis (rare)
```

### Hierarchy Test

1. **Squint test** — Can you see 3 clear levels?
2. **5-second test** — What do users see first?
3. **Scan test** — Can you skim headings?

### Anti-patterns

- Everything is bold → nothing is bold
- 10 different sizes → no clear scale
- Low contrast gray → invisible hierarchy
- Italic everywhere → meaningless emphasis

---

## 15. Pre-Ship Checklist

- [ ] **Scale:** Maximum 6-8 font sizes
- [ ] **Fonts:** Maximum 2 families (1 is better)
- [ ] **Weights:** 3-4 weights maximum (400, 500, 600)
- [ ] **Body:** 16px+, line-height 1.5+, max-width 65ch
- [ ] **Text colors:** 3-4 levels (primary, secondary, tertiary)
- [ ] **Headlines:** Tighter leading (1.1-1.2), optional negative tracking
- [ ] **ALL CAPS:** Has letter-spacing 0.06em+
- [ ] **Small text:** 11px minimum, has positive tracking
- [ ] **Contrast:** Passes WCAG AA (4.5:1 body, 3:1 large)
- [ ] **Performance:** font-display: swap, ≤3 weights loaded
- [ ] **Spacing:** Consistent vertical rhythm
- [ ] **Responsive:** Tested at 320px, 768px, 1440px
- [ ] **Hierarchy:** Passes squint test
- [ ] **Punctuation:** `…` not `...`, curly quotes, non-breaking spaces
- [ ] **Numbers:** `tabular-nums` in tables/stats/prices
- [ ] **Headings:** `text-wrap: balance`; no awkward one-word final lines
- [ ] **Prose:** `text-wrap: pretty` only where typographic quality matters
- [ ] **Overflow:** Text containers handle long content (truncate/clamp/break)

---

## Appendix: Complete Token System

Reference implementation with all tokens:

```css
:root {
  /* Font Families */
  --font-body: 'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', monospace;

  /* Font Sizes (Minor Third scale) */
  --text-xs: 0.6875rem;    /* 11px */
  --text-sm: 0.8125rem;    /* 13px */
  --text-base: 1rem;       /* 16px */
  --text-lg: 1.1875rem;    /* 19px */
  --text-xl: 1.4375rem;    /* 23px */
  --text-2xl: 1.75rem;     /* 28px */
  --text-3xl: 2.0625rem;   /* 33px */
  --text-4xl: 2.5rem;      /* 40px */

  /* Font Weights */
  --font-normal: 400;
  --font-medium: 500;
  --font-semibold: 600;

  /* Line Heights */
  --leading-none: 1;
  --leading-tight: 1.15;
  --leading-snug: 1.3;
  --leading-normal: 1.55;
  --leading-relaxed: 1.7;

  /* Letter Spacing */
  --tracking-tight: -0.01em;
  --tracking-normal: 0em;
  --tracking-wide: 0.015em;
  --tracking-caps: 0.08em;

  /* Text Colors */
  --text-primary: #0B0B0B;
  --text-secondary: rgba(0,0,0,0.65);
  --text-tertiary: rgba(0,0,0,0.45);
  --text-disabled: rgba(0,0,0,0.3);

  /* Spacing (based on 24px line-height) */
  --space-xs: 12px;
  --space-sm: 24px;
  --space-md: 48px;
  --space-lg: 72px;
}
```

---

*Typography is the voice of your interface. Simple, consistent, intentional.*
