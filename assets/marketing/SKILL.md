---
name: syrin-iris-creatives
description: >-
  Create on-brand Syrin / Iris marketing images (Instagram, LinkedIn, X/Twitter, Reddit),
  benchmark graphs, explainers, and launch assets. Authors HTML cards rendered to crisp 2x PNGs.
  Use whenever designing social creatives, comparison/benchmark graphics, OG images, or launch
  visuals for Iris. Enforces the design system, the pain-first narrative, and per-channel sizing.
---

# Syrin / Iris — Creatives Skill

How we make every Iris marketing image. Follow this exactly; the look is consistent because the
rules are non-negotiable. Images are **HTML cards → screenshot to PNG** via Playwright.

## Pipeline (how an image is made)

Files live in `assets/marketing/`:
- `src/*.html` — one file per image. **Line 1 must be** `<!--SIZE:WIDTHxHEIGHT-->`.
- `src/_system.css` — the shared design system (tokens, fonts, mesh, grain, icons, helpers). Every card links it: `<link rel="stylesheet" href="_system.css">`.
- `render.mjs` — renders every `src/*.html` to a `.png` beside it at **deviceScaleFactor 2**, waiting for `document.fonts.ready`.

Workflow: **write HTML → `node assets/marketing/render.mjs` → Read the PNG to visually QA → fix → re-render.** Always eyeball the rendered PNG; do not trust the markup alone.

## NON-NEGOTIABLE design rules

1. **4px grid.** All padding / margin / gap / radius come from the `--s*` and `--r*` tokens (multiples of 4). Never an arbitrary pixel gap.
2. **Fonts: Inter for everything. JetBrains Mono ONLY for code** (commands, file paths, API routes, code snippets, the `@syrin/iris` / `npm i` bits). Never a mono label for normal copy. Never system fonts, never Clash Display (tried, rejected: bad spacing).
3. **No emoji. Ever.** Replace with the SVG line-icons (`.ico`, consistent 2px stroke, `currentColor`). This includes checkmarks/crosses — use the icon paths, not ✅/✕ glyphs.
4. **No em-dashes (—) or en-dashes (–)** in copy. Use periods, commas, or restructure. (`&rarr;` for arrows in code is fine.)
5. **No "X, not Y" / "it's not just X, it's Y" phrasing.** It reads AI-generated. Use plain human sentences and parallel pairs of lived experience instead.
6. **No cliché purple→blue / blue→pink gradient on text.** It screams AI. Emphasis is either a **warm highlight marker** (`.hi`, default warm peach) or **one confident solid color** (cyan / red / green).
7. **Soothing, blended gradient mesh + grain**, not hard neon blobs. Use `.bg-dark` or `.bg-light` (layered soft radial mesh) plus a `<div class="grain">`. OpenAI-soft, not loud.
8. **Generous space between the brand lockup and the headline** (>= `--s12`). Cramped logo/title looks off.
9. **Brand lockup** = `syrin` wordmark + `/` + `Iris` (company / product). Use `wordmark-white.svg` on dark, `wordmark-black.svg` on light. SVGs in `assets/`.
10. **Coordinates footer**: `syrin.ai/iris` (sans) and the code-y bits (`@syrin/iris`, `npm i -D @syrin/iris`) in `.code` (mono).
11. **Line-height**: display `1.05–1.08`, body/lead `1.5–1.55`. Display tracking `-.03em` to `-.035em`.

## NON-NEGOTIABLE content rules

1. **PAIN FIRST, always.** State the problem / the wound before naming Iris. The arc is: *feel the pain → what Iris is → how cheap/easy.* Never open with a feature or a number.
2. **Instant comprehension.** Every line must read like you're explaining to a five-year-old. No jargon. If it needs a second read, rewrite it. Less text, more understanding.
3. **Name the tools** people actually use: Claude Code, Cursor, Codex, Antigravity, Lovable, Bolt.
4. **Human, emotional titles** that hit a nerve. Pull from the validated pain language in `plan/market/01-market-validation.md` ("hands but no eyes," "programming with a blindfold on," "it worked in the chat, broke in the app," "your AI says done, it isn't").
5. **Conversation bait** for social: relatable confessions, fake group chats, polls, "spot the bug," hot takes. Make people tag/comment/share.
6. **Accuracy is sacred** (the audience grills). Use only the verified numbers below and **keep them reconciled across every asset and the docs**. Never fabricate stars, users, or ratios.

## Verified numbers (single source of truth)

| Claim | Value |
| --- | --- |
| Tokens per verify loop (Iris) | **~100** (query 28 + observe 39 + assert 33) |
| Tokens per step (Playwright MCP, with-refs payload) | **~7,300** (bare a11y tree ~6,856) |
| Headline ratio | **73×** (100 vs ~7,300). 100–500× on complex pages |
| Full-tree vs full-tree (honest caveat) | **~1.8×** (4,144 vs 7,300) |
| Single assert | **~33 tokens**, no screenshot, deterministic |
| 20-step flow | **~2,000** (Iris) vs **~146,000** (full-tree) |
| Footprint | **44** MCP tools, **7** observers, **2,000-event / 60s** buffer, **95** test files |
| Speed | ~10ms verdict, ~0.9s per verified interaction, 0 browsers to boot |
| Safety / stack | MIT, dev-only, localhost-only, no telemetry, React 18/19 + Next |

Always publish the **honest caveat** next to the headline ratio (1.8× full-tree). Honesty is the differentiator with technical audiences.

## Per-channel sizing + voice

| Channel | Size(s) | Voice |
| --- | --- | --- |
| **X / Twitter** | 1600×900 (16:9, no crop); link card 1200×628 | Scroll-stopper. Launch energy. One idea per card. Hook on line one. |
| **Instagram** | 1080×1350 (portrait, preferred), 1080×1080; Reels/story 1080×1920 | Playful, relatable, meme-aware, tag-a-friend. |
| **LinkedIn** | 1080×1350 (portrait, max feed); link 1200×627 | Insight / debate. "Uncomfortable truth," polls, the moved-bottleneck. Slightly more pro, still bold. |
| **Reddit** | 1600×1000 / 1600×900 (landscape) | Typography-led, real code, honest numbers, fair to competitors. Technical and grill-proof. |
| **GitHub OG** | 1280×640 | Repo social card. |

## The system at a glance (see `_system.css` for exact values)

- **Spacing**: `--s1`(4) … `--s32`(128). **Radii**: `--r2`(8) … `--r8`(32), `--rpill`.
- **Type scale**: `--t-mono` 17 · `--t-xs` 19 · `--t-sm` 22 · `--t-base` 26 · `--t-md` 32 · `--t-lg` 42 · `--t-xl` 54 · `--t-2xl` 72 · `--t-3xl` 92 · `--t-4xl` 116.
- **Color**: `--ink #f5f4fb`, `--muted`, `--faint`; `--iris #8b7bff`, `--iris-bright`, `--cyan #5fd9f5`, `--blue`, `--green #46d6a0`, `--red #ff6b86`, `--peach`, `--amber`. Light theme uses `--ink-on-light` / `--muted-on-light`.
- **Fonts**: `--sans` Inter, `--mono` JetBrains Mono (loaded via Google Fonts @import).
- **Helpers**: `.bg-dark` / `.bg-light` (mesh), `.grain`, `.brand`, `.eyebrow`, `.lead`, `.hi` (highlight marker, set `--hi`), `.code`, `.coords`, `.ico`, `.stroke` (outline text), `.tag-problem` / `.tag-solution`, `.term` (code surface with traffic-light bar + `.k/.s/.ok/.bad/.num/.cm` syntax colors).

## Icon set (inline SVG, 24×24, stroke = currentColor)

check `M4 12.5l5 5L20 6.5` · x `M6 6l12 12M18 6L6 18` · eye `M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z` + `<circle r=3>` · check-circle `<circle r=9>`+check · layers `M12 3l9 5-9 5-9-5 9-5z`+`M3 13l9 5 9-5` · broadcast nested arcs + dot · crosshair `<circle r=8><circle r=2.5>`+ticks · grid `<rect rx=3>`+`M4 10h16M10 4v16` · cursor `M5 3l5 16 2.2-6.8L19 10z` · arrow-right `M5 12h14M13 6l6 6-6 6`. Add new icons in the same flat, rounded, 2px-stroke style.

## QA checklist (run before declaring an image done)

- [ ] **Read the rendered PNG** and look at it. Spacing on grid? Logo-to-title gap generous? Nothing clipped/overflowing?
- [ ] `grep -lP "[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}...]" src/*.html` → **no emoji**.
- [ ] `grep -l $'—\|–' src/*.html` → **no em/en-dashes**.
- [ ] Mono used **only** for code; everything else Inter.
- [ ] Numbers match the verified table and the docs (73× / ~7,300 / ~100 / 1.8×).
- [ ] Reads pain-first, instantly understandable, no "X not Y," human title.
- [ ] Correct size for the channel.

## Install as an invokable skill (optional)

Copy this folder's `SKILL.md` to `~/.claude/skills/syrin-iris-creatives/SKILL.md` (or a project `.claude/skills/`) to invoke it by name. The pipeline (`render.mjs`, `_system.css`, `src/`) stays in `assets/marketing/`.
