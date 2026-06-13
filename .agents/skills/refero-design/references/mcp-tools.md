# Refero MCP Tools Reference

MCP clients may namespace tool names, but the Refero tools are exposed with the
`refero_` prefix. Use the exact tool names shown by the client.

Refero has three research layers:

1. Styles - visual direction and taste.
2. Screens - concrete UI patterns and product-screen decisions.
3. Flows - multi-step journey logic.

## Styles

### `refero_search_styles`

Search curated design styles using semantic search.

Use first for any task with visual direction, brand feel, typography, color, layout,
spacing, elevation, components, imagery, art direction, design-system inspiration, or
visual polish.

What results contain:

- style UUID
- title
- source URL
- preview image URL
- platform
- rich natural-language description of the visual language

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `query` | string | Yes | Semantic query for aesthetic, domain, audience, category, or brand direction. |
| `page` | number | No | Pagination. Use later pages to explore less obvious directions. |

Good queries:

```text
editorial monochrome SaaS landing page
warm trustworthy healthcare product marketing
premium fintech website with restrained typography
developer tool website with product screenshots
luxury ecommerce editorial product page
productivity SaaS with airy spacing
Attio editorial SaaS typography
Linear changelog dark developer tool
```

Search method:

- Search 3-5 different visual angles.
- Include one broad aesthetic query.
- Include one domain/category query.
- Include one known-brand or strong-product query when relevant.
- Do not stop at the first good result.

Current coverage:

- Styles currently focus on web marketing/product pages: landing pages, pricing pages,
  product marketing sites, editorial brand sites, and SaaS websites.
- Styles do not currently cover in-app dashboards, auth screens, settings screens, or iOS
  app screens as style systems.
- Even for product UI, use styles to establish taste and visual language, then use
  screens/flows for product-specific logic.

### `refero_get_style`

Retrieve full design style references for one or more style UUIDs.

Use after `refero_search_styles` to turn promising style previews into actionable design
material.

What results may include:

- visual thesis / north star
- colors and usage roles
- typography and type scale
- layout guidance, section rhythm, and composition patterns
- spacing, radius, shadows, elevation, surfaces
- component treatments and sometimes component/code examples
- imagery, graphics, illustration, or product screenshot treatment
- do/don't rules
- agent prompt guidance or implementation notes

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `style_id` | string | Yes* | Style UUID from `refero_search_styles`. *Exactly one of `style_id` or `style_ids` must be provided.* |
| `style_ids` | string[] | Yes* | Array of style UUIDs. Full styles are large; recommended max batch is 3-4. *Exactly one of `style_id` or `style_ids` must be provided.* |
| `response_format` | enum | No | `json` or `md`. Default: `md`. |

How to use returned styles:

- Treat each style as a reference ingredient, not a template.
- Pick one primary foundation for mood and density.
- Borrow 1-2 specific details from other styles.
- Extract layout, component, spacing, and elevation rules, not only colors and fonts.
- Preserve source token/component roles instead of repurposing them.
- Preserve imagery/media roles. Use real/generated/stock assets when possible; use an
  intentional placeholder with art direction when the needed asset is unavailable.
- Translate everything to the user's product, audience, and constraints.

## Screens

### `refero_search_screens`

Search real UI screens using semantic search.

Use for concrete interface decisions: page structure, component choices, content
hierarchy, copy, states, and product-specific patterns.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `query` | string | Yes | Search by screen type, UI element, pattern, state, company, or on-screen text. |
| `platform` | enum | Yes | `web` for web app/site patterns, `ios` for mobile app patterns. |
| `page` | number | No | Pagination. Use later pages to explore beyond obvious results. |

Good queries:

```text
pricing page annual monthly toggle
feature comparison table
dashboard empty state
billing settings cancellation modal
onboarding progress indicator
2FA setup recovery codes
data table filters
destructive action confirmation
```

Search guidance:

- Search by what is literally on the screen.
- Prefer concrete UI terminology over broad aesthetic words.
- If the main query is aesthetic ("premium", "minimalist", "editorial", "dark"), search
  styles first.
- Use `page` for search pagination. Do not pass `limit`, `image_size`, or
  `include_similar` to search tools.

### `refero_get_screen`

Get full details for one or more screens by UUID.

Use after `refero_search_screens` when a result looks relevant and you need deeper
metadata, descriptions, app/site info, patterns, elements, fonts, or content structure.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `screen_id` | string | Yes* | One screen UUID. Use exactly one of `screen_id` or `screen_ids`. |
| `screen_ids` | string[] | Yes* | Multiple screen UUIDs. Use exactly one of `screen_id` or `screen_ids`. |

Batching:

- Retrieve a few strong screens at a time.
- If a batch fails, retry with fewer IDs.

### `refero_get_similar_screens`

Get visually and functionally similar screens for a screen UUID.

Use when one screen is especially relevant and you want comparable examples fast.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `screen_id` | string | Yes | UUID from `refero_search_screens` or `refero_get_screen`. |
| `limit` | number | No | Number of similar screens. Default is usually 10; max is usually 20. |

### `refero_get_screen_image`

Get raw screenshot image content by UUID.

Use only when text metadata is not enough and you need to visually inspect the exact
screenshot. This returns image content and can use more context than text tools.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `screen_id` | string | Yes | UUID from `refero_search_screens` or `refero_get_screen`. |
| `image_size` | enum | No | `thumbnail` or `full`. Default: `thumbnail`. |

## Flows

### `refero_search_flows`

Search user flows: connected screens showing how a user completes a task.

Use for journey logic: onboarding, checkout, signup, cancellation, upgrade, settings,
account deletion, password reset, and other before/after sequences.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `query` | string | Yes | Search by task, journey, company, industry, or key step. |
| `platform` | enum | Yes | `web` for web app/site flows, `ios` for mobile app flows. |
| `page` | number | No | Pagination. Use later pages to explore more examples. |

Good queries:

```text
signup onboarding
checkout with promo code
subscription cancellation
account deletion feedback
password reset 2FA
workspace billing upgrade
```

### `refero_get_flow`

Get full details for one or more user flows.

Use after `refero_search_flows` to understand step-by-step goals, actions, system
responses, screens, user problem, and related search queries.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `flow_id` | number | Yes* | Numeric flow ID. Use exactly one of `flow_id` or `flow_ids`. |
| `flow_ids` | number[] | Yes* | Multiple numeric flow IDs. Use exactly one of `flow_id` or `flow_ids`. |

## Response Formats

Some clients expose a `response_format` parameter on Refero tools. Use it only when the
tool schema shown by your client includes it:

- `md` / markdown for human-readable research notes.
- `json` for structured comparison or when extracting fields programmatically.

## Common Mistakes

- Do not use old `_tool` suffixed names.
- Do not call `get_design_guidance`; use styles/screens/flows research instead.
- Do not pass `image_size` to `refero_get_screen`; use `refero_get_screen_image` for raw images.
- Do not pass `include_similar` to `refero_get_screen`; use `refero_get_similar_screens`.
- Do not use screens as the main source for visual taste when styles are available.
- Do not assume styles include dashboards, auth screens, or iOS app screens as style systems.
- Do not copy a single style directly.

## If Results Are Weak

- Broaden the query.
- Remove extra adjectives or constraints.
- Search adjacent categories.
- Try a known-product or best-brand query.
- Inspect later pages.
- For sparse flows, search related screens and reconstruct the journey manually.
