# Anti-AI-Slop Guide

Your design must NOT look AI-generated. AI interfaces converge on the same tired patterns because they optimize for "safe" and "average." Real designers make intentional, contextual choices.

---

## 🚨 THE #1 TELL: INDIGO/VIOLET

Every AI model defaults to indigo/violet (`#6366f1`, `#8b5cf6`, `#7c3aed`). It's the universal fingerprint of AI-generated design.

Why it happens: training data saturated with Tailwind's indigo. LLMs optimize for the average, and indigo IS the average.

**RULE: NEVER use indigo/violet unless the brand explicitly requires it.**

| Instead of | Try | Feeling |
|------------|-----|---------|
| Indigo `#6366f1` | Blue `#2563eb` | Trust, professional |
| Violet `#8b5cf6` | Teal `#0d9488` | Fresh, distinctive |
| Purple `#7c3aed` | Brand color | Authentic, intentional |

---

## 🚨 THE #2 TELL: CARDS EVERYWHERE

Cards are the second most common AI-slop pattern. AI models wrap everything in rounded-corner boxes with shadows because it feels "safe." Real designers use cards sparingly.

**RULE: Default is NO cards. Use sections, columns, dividers, or media blocks instead.**

Cards are only justified when they are the container for a user interaction (clickable item, form, expandable panel). If removing the border, shadow, background, or radius doesn't hurt interaction or understanding — it's not a card, remove it.

Ask: "Is this a card because the user needs to interact with this container, or because I couldn't think of another way to group things?" If the latter — remove the card.

---

## 🚨 THE #3 TELL: DARK MODE BY DEFAULT

AI models default to dark backgrounds. Dark-by-default is an AI fingerprint just like indigo.

**RULE: Unless the brief explicitly asks for dark — use light mode.**

Dark mode is a deliberate brand choice, not a default. When a brief says nothing about color mode, light mode is the professional baseline.

---

## 🚨 THE #4 TELL: CALM EDITORIAL SERIF ON AUTOPILOT

Newer models often avoid obvious indigo SaaS slop by switching to another safe template:
warm ivory/cream background, oversized high-contrast serif headline, one italic serif
word, muted olive/clay/terracotta accents, very airy spacing, and "calm editorial"
positioning regardless of the product.

This can be excellent for an editorial brand, cultural product, hospitality site, or
fashion/lifestyle page. It becomes AI slop when applied by default to browsers, dev
tools, enterprise SaaS, fintech, dashboards, or functional product UI without research.

**RULE: Do not use the calm editorial serif + earth-tone pattern unless the product context
and Refero research justify it.**

Before using it, you must be able to explain:
1. Why this product needs an editorial or literary voice.
2. Why a serif display font communicates the brand better than a sans/system face.
3. Why warm ivory, olive, clay, terracotta, or other earth tones fit the audience.
4. Which references support this exact direction.

If you cannot answer those, choose a sharper product-specific direction: technical,
utilitarian, high-contrast, image-led, data-dense, playful, industrial, clinical,
luxury, or another style grounded in research.

Specific fingerprint to avoid: a headline where one word or short phrase is swapped into
a different display/serif/script face, italicized, and/or color-shifted only to create "taste."
The base headline can be serif or sans; the slop is the decorative one-word treatment.
This is now a common AI default. Use contrasting word treatment only when a strong
reference uses it and the content role justifies it: quotation, editorial voice, title
treatment, or a real brand/type-system rule. Otherwise create distinction through layout,
scale, weight, media, interaction, or a source-backed color role.

Serif fonts and earthy palettes are not banned. Autopilot "calm editorial" is.

---

## 🚨 THE #5 TELL: EMOJI AS ICONS

Standard emoji (😀🚀💡🎯) immediately signal "AI-generated." They're a shortcut that makes any design look cheap and unfinished.

**RULE: Never use emoji unless the user explicitly asks for them.**

Use instead: icon libraries (Lucide, Phosphor, Heroicons), Unicode symbols (→ • ◆), SVG graphics. Even a simple text character beats a yellow smiley in a professional UI.

---

## 🚨 THE #6 TELL: LEFT ACCENT STRIPE

The colored vertical bar on the left edge of a card (`border-left: 4px solid <accent>`). AI models add it for "visual interest" — but in shipped products this stripe is reserved for elements that carry meaning: callouts, alerts, active list items, status, priority.

**RULE: Only use a side accent stripe when it communicates something — status, priority, owner, or selection. Never as decoration.**

If you can't say in one word what the color means, remove the stripe.

---

## 🚨 THE #7 TELL: REFERENCE AVERAGING

AI models often do real research, then destroy it by averaging strong references into the
safest middle point. This is how a dark workbench, acid-yellow document site, saturated
orange product brand, and serif editorial page become the same warm cream canvas with
muted clay accents.

**RULE: Synthesis means choosing and adapting, not finding the least risky intersection.**

Red flags:
- Dark canvases become cream.
- Acid or saturated accents become muted clay/olive.
- Geometric sans systems become polite serif headlines.
- Sharp/zero-radius UI becomes soft rounded cards.
- Distinctive media or layout becomes generic hero + sections.

When references conflict, choose one primary direction and preserve its signature traits.
Secondary references may contribute 1-2 specific details, but they must not dilute the
primary direction. A bold reference should either stay bold or be rejected; it should not
be softened into average AI taste.

---

## 🚨 THE #8 TELL: TOKEN ROLE DRIFT

Another failure mode: the agent uses real style tokens but changes what they mean. A
source says "acid yellow only for primary CTA," then the design uses it as a section
background. A source says "syntax colors only inside code snippets," then those colors
become UI accents. A source says "pastels are decorative atmosphere," then they become
cards and controls.

**RULE: A token's role is part of the token. Preserve it or do not use it.**

Red flags:
- CTA-only accents used as backgrounds, borders, badges, or decorative fills.
- Code syntax colors used outside code windows.
- Decorative gradients/pastels turned into core UI surfaces.
- Source button radius or shadow recipes changed to feel safer.
- Component treatments mixed without preserving their source states.

When combining references, assign each source a bounded job and respect its rules. One
source can own canvas/type, another can own code-window treatment, another can own primary
CTA. The result becomes unique through composition, not by changing the meaning of tokens.

---

## 🚨 THE #9 TELL: FAKE GRAPHICS OR TEXT-ONLY COLLAPSE

Many strong references are image-led: photography, product screenshots, custom
illustration, editorial graphics, diagrams, textures, or atmospheric media. Agents often
collapse these into text, layout, and CSS decorations because they cannot generate the
image. The result loses the style's main carrier.

**RULE: Preserve the media role. Use a real asset, generated/stock asset, code-native
primitive, product screenshot, or intentional placeholder. Do not fake complex imagery.**

Good substitutes:
- Real product screenshot, provided asset, stock photo, or generated image when available.
- Code-native primitive only for simple diagrams, icons, charts, code windows, grids, or
  geometric patterns that match the reference.
- Intentional placeholder when the needed asset is unavailable: fixed aspect ratio, clear
  art direction, alt/caption, and enough visual space to keep the composition honest.

Red flags:
- Replacing an image-led hero with only text and buttons.
- Drawing fake photos, fake editorial art, or complex illustrations with weak CSS blobs.
- Using generic gradients or abstract shapes where the reference relies on specific media.
- Collapsing product screenshots into decorative cards with no real content.

Placeholder is acceptable when it prevents bad fake imagery. It is not acceptable when a
real screenshot, simple code-native graphic, stock/generative asset, or provided asset is
available and appropriate.

---

## What Makes Design Look Generic

**Typography symptoms:**
- Same font as every other AI site, same weight throughout
- No distinction between display and body text
- One-word/short-phrase serif, italic, or color highlight used only to feel "tasteful"
- Missing letter-spacing on ALL CAPS and small text

**Color symptoms:**
- Default indigo/violet, gradients that don't serve function
- Warm ivory + olive/clay/terracotta chosen because it feels safe, not because it fits
- Distinctive reference colors muted into the same safe earth-tone palette
- Source colors used outside their stated role
- Perfectly even color distribution, no clear accent hierarchy

**Layout symptoms:**
- Perfectly symmetrical everything, cookie-cutter card grids
- Hero with left text + right image (every landing page ever)
- Calm editorial landing layout applied to products that need utility, speed, or proof
- Signature reference layouts collapsed into generic section stacks
- Centered everything with no visual tension

**Visual symptoms:**
- Abstract blob backgrounds, generic 3D illustrations
- Weak CSS fakes for photography, editorial art, or product imagery
- Image-led references collapsed into text-only layouts
- Effects without purpose, stock imagery that could be anywhere

---

## The Antidote: Intentional Design

**Typography with purpose:**
- Choose fonts that match your tone from research
- Create clear hierarchy (3-4 distinct levels)
- Use weight and spacing to differentiate, not just size

**Color with meaning:**
- Build palette from references, not defaults
- Use dominant + sharp accent, not evenly distributed
- Make semantic colors actually semantic

**Layout with intention:**
- Create visual tension through asymmetry
- Use whitespace as a design element
- Break the grid intentionally (one element, not everything)

**Details that distinguish:**
- Custom illustrations or real photography
- Micro-interactions that reinforce brand
- Shadows and depth when they serve hierarchy
- One memorable detail users will actually remember

---

## The AI Slop Detector Checklist

Before shipping any design:

```
□ Accent color is NOT indigo/violet
□ Cards are justified by interaction, not used as default containers
□ No decorative left/side accent stripes
□ No standard emoji used as icons
□ Color mode is light unless brief explicitly asks for dark
□ Serif display / warm editorial treatment is justified by product context
□ Earth-tone palette is research-backed, not a safe default
□ No decorative one-word serif/italic/color highlight unless research and content role justify it
□ Strong reference traits were preserved, not averaged away
□ Source token/component roles were preserved
□ Image/media roles are preserved with a real asset, appropriate primitive, or intentional placeholder
□ ALL CAPS text has letter-spacing
□ Would pass the "screenshot test" next to real products
□ Font choices are intentional and contextual
□ Colors derived from research, not defaults
□ Layout has visual interest and tension
□ No generic patterns you can't justify
□ You can explain WHY each design choice was made
```

---

## Litmus Tests

Run these against your design before shipping:

**Card test:** If removing border + shadow + background + radius doesn't hurt interaction or understanding → it's not a card, remove it.

**Image test:** If the first viewport works fine without the hero image → the image is too weak. Make it dominant or remove it.

**Brand test:** If the brand disappears after hiding the nav → hierarchy is too weak. Make brand louder — bigger logo, brand color in hero, distinctive typography.

**Copy test:** If deleting 30% of copy improves the page → keep deleting. AI over-writes; real designers edit down.

**Identity test:** If the first viewport could belong to any other company → branding is too weak. Add the one detail that makes this unmistakably THIS brand.

**Editorial test:** If replacing the logo with a coffee shop, boutique hotel, or literary
magazine still makes the hero feel plausible → the design is probably generic calm
editorial slop. Make the visual language specific to the actual product.

---

## Safe vs. Intentional

Safe (forgettable):
- 3-column pricing because "everyone does it"
- Hero with left text + right image because "it works"
- Card grid with equal spacing because "it's clean"
- Cream background + serif headline + olive accent because it feels tasteful

Intentional (memorable):
- 2-column pricing because your product only has 2 tiers
- Full-width hero image with overlay because it fits the brand
- Asymmetrical layout because you want visual tension
- Serif editorial system because the product is actually publishing, culture, fashion, hospitality, or another content-led brand

"I chose this because [specific reason for THIS project]" beats "I chose this because everyone does it."
