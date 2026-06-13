# Example Workflow: SaaS Pricing Page

This walkthrough shows the expected shape of a Refero Design process. Replace the example
references with actual results from the MCP during real work.

Task: design a pricing page for **Northstar**, a B2B analytics product for operations teams.
The page must feel trustworthy, precise, and modern without looking like a generic AI SaaS
template.

---

## Phase 0: Discovery

Brief:

```text
Designing a web pricing page for operations leaders and finance stakeholders.
Goal: help qualified teams choose a plan or contact sales with confidence.
Tone: precise, calm, credible, quietly premium.
Main objection/risk: unclear ROI and fear of enterprise lock-in.
Must remember: pricing feels transparent and tied to operational value.
Constraints: existing product uses dense dashboards; avoid flashy gradients.
Research needed: styles for visual language, screens for pricing structure, flows for upgrade/billing sequence.
```

---

## Phase 1: Styles Research

Start with styles because this is a visual/brand task.

### Style Searches

```text
editorial monochrome SaaS landing page
premium data infrastructure website restrained typography
developer tool website with product screenshots
productivity SaaS with airy spacing
enterprise analytics product marketing
```

Open 3-4 strong styles with `refero_get_style`; full styles are large, so split larger
research into multiple batches.

### Style Findings

| Reference | What It Contributes | What To Adapt |
|-----------|---------------------|---------------|
| Style A: editorial monochrome SaaS | Strong typographic hierarchy, low color, confidence through restraint | Use a mostly neutral palette and crisp type scale |
| Style B: data infrastructure website | Dense technical credibility, grid structure, product screenshot framing | Use structured comparison tables and screenshot panels |
| Style C: productivity SaaS | Airy spacing, friendly trust, softer supporting sections | Add breathing room around plan cards and proof sections |
| Style D: premium fintech/product marketing | Subtle accent discipline, numbers presented with authority | Use exact ROI metrics and restrained accent color |

### Visual Direction Synthesis

Primary foundation: data infrastructure website.

Borrowed details:

- From editorial SaaS: tighter type hierarchy and low color discipline.
- From productivity: more generous section spacing and softer proof blocks.
- From premium fintech: accent color reserved for value proof and selected plan state.

Reference lock:

```text
Primary reference/direction: data infrastructure website.
Preserve: precise grid, compact comparison table, screenshot framing, sans-led UI,
technical confidence, restrained neutral canvas.
Borrow only: editorial type hierarchy, productivity spacing, fintech proof treatment.
Role rules: green proof accent only for selected state/value proof; product screenshot
frames only for evidence; cards use pricing-screen interaction rules, not decoration.
Media strategy: real product screenshots when available; otherwise fixed-ratio screenshot
placeholders with labels and art direction, not fake decorative app mockups.
Reject: cream editorial canvas, serif hero, muted clay/orange accent, decorative cards.
Token commitments: white/charcoal/cool-neutral canvas, sans typography, green proof
accent, 8px max radius, thin borders, product screenshots as evidence.
```

Resulting direction:

```text
A precise, evidence-led pricing page: white canvas, deep charcoal text, compact sans-led
headlines, thin rule lines, quiet plan cards, and exact operational metrics. Use one
muted green accent for value proof and selected actions. Product screenshots should be
framed as evidence, not decoration.
```

---

## Phase 2: Screen Research

Use screens for concrete pricing decisions after visual direction is clear.

### Screen Searches

```text
pricing page annual monthly toggle
feature comparison table SaaS pricing
usage based pricing enterprise
contact sales pricing page
pricing page ROI calculator
```

Open the strongest screens with `refero_get_screen`. Use `refero_get_similar_screens` if
one example is especially relevant.

### Screen Findings

| Pattern | What To Look For | Decision |
|---------|------------------|----------|
| Plan cards | Number of plans, highlighted plan, CTA hierarchy | Use 3 plans; highlight Pro as default |
| Billing toggle | Placement, annual discount language, interaction clarity | Put monthly/annual toggle above cards; show exact annual savings |
| Feature comparison | Whether comparison is complete or simplified | Use compact comparison under cards with expandable details |
| Enterprise CTA | How sales motion is framed | Use "Talk to sales" for Enterprise with proof and security cues |
| ROI proof | Placement of metrics/calculator | Add ROI strip between plan cards and comparison table |

Concrete tactics to adapt:

- Put "No credit card required" near the trial CTA, not buried in FAQ.
- Show annual savings as exact value where possible, not just a percentage.
- Make Enterprise feel like a tailored plan, not a vague catch-all.
- Use a comparison table for evaluation buyers, but keep the first viewport decisive.
- Include security/procurement signals near the Enterprise CTA.

---

## Phase 3: Flow Research

Use flows because pricing can lead into upgrade, checkout, or sales contact journeys.

### Flow Searches

```text
workspace billing upgrade
checkout subscription SaaS
contact sales pricing
trial signup billing
```

Open relevant flows with `refero_get_flow`.

### Flow Findings

| Journey Question | Finding To Extract | Decision |
|------------------|-------------------|----------|
| What happens after plan selection? | Does the product ask for account, payment, or workspace first? | Trial CTA starts account creation before payment |
| How is annual billing confirmed? | Are savings and renewal dates repeated? | Repeat billing period and savings in checkout |
| How does sales contact work? | Is it calendar, form, or direct email? | Enterprise CTA opens short sales form with company size |
| How are errors/recovery handled? | Can users return to pricing without losing state? | Keep selected plan visible through signup |

---

## Phase 4: Synthesis

### Research Summary

```text
Research summary:
- Styles reviewed: 5 across editorial SaaS, data infrastructure, productivity, fintech.
- Screens reviewed: pricing cards, billing toggles, feature comparison, ROI proof, enterprise CTAs.
- Flows reviewed: upgrade, checkout, sales contact.

Visual direction:
- Primary foundation: data infrastructure website.
- Reference lock: precise grid, compact comparison, sans-led UI, product evidence.
- Borrowed detail 1: editorial type hierarchy and low color discipline.
- Borrowed detail 2: fintech-style precision around numbers and proof.

Product patterns:
- 3 plan cards with Pro highlighted.
- Monthly/annual toggle above cards.
- ROI proof strip before detailed comparison.
- Enterprise CTA supported by security/procurement signals.

Journey logic:
- Trial starts account creation before payment.
- Checkout repeats selected plan, billing period, savings, and renewal date.
- Enterprise route asks only for essential qualification fields.
```

### Design Decision Ledger

| Area | Decision | Source | Source rule / role | Why |
|------|----------|--------|--------------------|-----|
| Palette | White, charcoal, cool neutrals, muted green accent | Style B + fintech reference + brief | Accent only for value proof and selected actions | Trustworthy and precise; avoids generic blue/purple SaaS |
| Typography | Sans-led hierarchy, tight headings, readable 15-16px body | Style B + Style A hierarchy | Use hierarchy, not decorative serif voice | Premium without becoming decorative or literary |
| Layout | Precise grid, compact comparison structure, proof near decision points | Style B + pricing screens | Grid is the core layout rule, not generic stacked sections | Keeps the page scannable for evaluation buyers |
| Media | Product screenshots as evidence panels | Style B + brief | Use real screenshots or labeled placeholders; no fake decorative mockups | Keeps proof honest without low-quality invented imagery |
| Cards | Thin borders, subtle selected state, no heavy shadows | Pricing screens + anti-slop card rule | Cards only for plan comparison and interaction | Keeps evaluation calm and scannable |
| CTA hierarchy | Pro trial primary, Enterprise sales secondary | Pricing screens + buyer journey | Primary treatment only for self-serve action | Supports self-serve and sales-led paths |
| Proof | ROI metrics near pricing, security near Enterprise | Screen research + buyer objections | Proof modules near the decision they support | Answers buyer objections where they appear |
| Memorable detail | "Operational value" strip showing saved hours/cost by plan | Brief + analytics product context | Metric strip as evidence, not decoration | Makes pricing feel tied to outcome |

---

## Phase 5: Implementation Blueprint

### Tokens

```css
:root {
  --font-sans: "Inter", system-ui, sans-serif;
  --color-bg: #ffffff;
  --color-text: #171717;
  --color-muted: #6b7280;
  --color-line: #e5e7eb;
  --color-accent: #1f8a5b;
  --color-accent-soft: #e8f5ee;
  --radius-card: 8px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;
}
```

### Page Structure

```text
1. Pricing header
   - Literal headline: "Pricing"
   - Short value sentence tied to operations outcomes
   - Monthly/annual toggle

2. Plan cards
   - Starter, Pro, Enterprise
   - Pro highlighted
   - Exact CTA per plan
   - Objection killer under primary CTA

3. Operational value strip
   - Saved hours/month
   - Faster reporting
   - Forecast confidence

4. Feature comparison
   - Compact by default
   - Grouped by buyer concern

5. Enterprise proof
   - Security/procurement cues
   - Sales CTA

6. FAQ
   - Billing, cancellation, data, procurement
```

### Quality Gate

Before shipping:

- Styles influenced the visual language.
- Screens influenced concrete pricing structure.
- Flows influenced the post-click journey.
- The page does not copy one reference directly.
- The palette does not default to generic indigo/violet.
- The first viewport makes the pricing decision clear.
- Buyer objections are handled near the relevant action.
- The page has one memorable detail tied to this product's value.
