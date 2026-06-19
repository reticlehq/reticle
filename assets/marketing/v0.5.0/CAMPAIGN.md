# Iris v0.5.0 — Launch Campaign

**Library:** Iris — *eyes for your AI coding agent*
**Repo:** https://github.com/syrin-labs/iris · **npm:** `@syrin/iris`
**Tagline:** *Your AI writes the code. Iris tells it whether the code actually works — with evidence, not screenshots.*

> All visual assets render from this folder (`assets/marketing/v0.5.0/`) using the shared
> design system (`assets/marketing/src/_system.css` — Inter, real `syrin/Iris` wordmark,
> the `.hi` highlight marker). Re-render cards: `node assets/marketing/v0.5.0/render-cards.mjs`.
> Re-render the reel: `node assets/marketing/reels/capture-reels.mjs v05`.

---

## The story we're telling

Iris already did the hard thing: it gives a coding agent a **verdict, not a screenshot** — the API
call fired `200`, the modal opened, the route changed, *no console error slipped in.*

But every week the same DM arrived:

> *"I love what Iris does. I spent 20 minutes wrestling the daemon and MCP config before I saw a
> single verdict."*

The product was never the wall. **The setup was the wall.**

So v0.5.0 isn't a pile of features. It's a demolition.

- **Paste one line.** The smart proxy *starts itself* — no daemon to babysit.
- **`--drive <url>`** and Iris launches *its own* browser. The agent doesn't borrow your tab anymore.
- **Reruns ask zero questions** — `.iris.json` remembers everything.
- **Presenter mode** — watch the agent narrate and highlight what it's checking, live.
- **Self-updating** — the agent can check its own version, upgrade, and roll back.

We shipped it. Within a day, **~100 developers had it running** — and the replies made one thing
obvious: we'd been *underestimating* how much the setup was hurting people.

**The iris was always open. Now it opens itself.**

---

## Hook bank (use anywhere)

1. **"We deleted the hardest part of Iris — the part *before* it works."**
2. **"Your agent has been coding blind. We gave it eyes. v0.5.0 makes the eyes open themselves."**
3. **"100 developers. One pasted line. Zero daemons babysat."**
4. **"The setup *was* the bug. v0.5.0 is the fix."**
5. **"An iris that opens itself."**
6. **"Look → Act → Observe → Assert. Now there's a step zero, and it's just: paste."**
7. **"Stop letting your AI mark its own homework with a screenshot."**
8. **"It used to take 20 minutes to see your first verdict. Now it takes one line."**

---

## Visual asset map

All in `assets/marketing/v0.5.0/` unless noted. PNGs are 2× (retina).

| File | Ratio | Use |
|---|---|---|
| `hook-square.png` | 1:1 | IG feed, X image post |
| `hook-portrait.png` | 4:5 | IG feed (taller reach) |
| `hook-wide.png` | 16:9 | X card, LinkedIn, blog OG |
| `hook-story.png` | 9:16 | story, reel cover |
| `proof-100-square.png` | 1:1 | "100 devs" celebration |
| `proof-100-story.png` | 9:16 | story celebration |
| `before-after.png` | 16:9 | the setup demolition |
| `testimonial-1/2/3.png` | 1:1 | social-proof carousel |
| `feature-proxy/presenter/update.png` | 1:1 | IG carousel slides |
| `cta-wide.png` | 16:9 | closing CTA / pinned |
| `../reels/v05-setup-demolished.mp4` | 9:16 | Reel / Short / TikTok (13s) |

> **Product-demo cut:** real screen-capture clips live in `assets/clips/` (`iris_full_run.mov`,
> `iris_login_redeploy_action.mov`, `iris_talking_to_website.mov`). Use these for the Day 3 demo.

---

# 3-DAY CONTENT CALENDAR

> **Day 1 = Problem→Reveal**, **Day 2 = Proof→Testimonials**, **Day 3 = Demo→CTA**.

---

## DAY 1 — "The wall comes down"

### X / Twitter — thread
**Card:** `hook-wide.png` on tweet 1.

> **1/** Your AI coding agent has been marking its own homework.
>
> It writes the code, takes a screenshot, says "looks done" — and ships a silent 401.
>
> Iris gives it a verdict instead. Today we shipped v0.5.0, and it fixes the one thing everyone hated.

> **2/** Iris watches your *real running app* and answers one question: did the right thing actually happen?
>
> API fired `200`. Modal opened. Route changed. **No console error slipped in.** The webhook arrived.
>
> Pass / fail + evidence. ~100 tokens. Not a 7,300-token screenshot.

> **3/** So what did everyone hate? Setup.
>
> "Love it, but I spent 20 min wrestling the daemon + MCP config before my first verdict."
>
> We heard that one too many times. The product was never the wall. The setup was.

> **4/** v0.5.0 — the demolition:
> ◆ Paste one line. The proxy **starts itself.**
> ◆ `--drive <url>` → Iris launches **its own** browser.
> ◆ Reruns ask **zero** questions.
> ◆ Presenter mode: watch it narrate + highlight live.
> ◆ It can update + roll back **itself.**

> **5/** Before: `start daemon → wait → configure MCP → point at tab → pray`
>
> After:
> ```
> Follow https://raw.githubusercontent.com/syrinlabs/iris/main/SKILL.md
> ```
> Paste that into Claude Code / Cursor / Codex. That's the whole setup.

> **6/** The iris was always open. Now it opens itself.
>
> MIT. Dev-only. Localhost-only. No telemetry.
>
> ⭐ github.com/syrin-labs/iris

### LinkedIn
**Card:** `before-after.png`

> We almost shipped the wrong v0.5.0.
>
> The roadmap was full of new features. Then we actually read the feedback, and the same sentence kept showing up:
>
> *"I love what Iris does — I just spent 20 minutes wrestling the setup before I saw a single result."*
>
> Iris gives AI coding agents **eyes** into a running app: instead of a screenshot the agent can misread, it returns a verdict with evidence — the API call fired a 200, the route changed, no console error slipped in.
>
> The capability was never the problem. The *first five minutes* were.
>
> So v0.5.0 is mostly subtraction:
> → Paste one line. The proxy starts itself — no daemon to manage.
> → Point it at a URL and it launches its own browser.
> → Run it again tomorrow and it asks you nothing.
>
> We shipped it over the weekend. By the next night, ~100 developers had it running — and the replies made it clear we'd been underestimating how much that setup friction was costing people.
>
> The lesson I keep relearning: your adoption curve is usually capped by your *worst* five minutes, not your best feature.
>
> MIT, dev-only, no telemetry → github.com/syrin-labs/iris
>
> #AI #DeveloperTools #OpenSource #AICodingAgents

### Instagram — feed caption (`hook-portrait.png`)
> Your AI says "done." Iris says "prove it."
>
> v0.5.0 is live — and the whole setup is now ONE pasted line. The proxy starts itself. It drives its own browser. Reruns ask you nothing.
>
> We deleted the hardest part of Iris: the part *before* it works.
>
> ⭐ Star it → link in bio · github.com/syrin-labs/iris
>
> #aicoding #developertools #opensource #typescript #codingagents #buildinpublic

### Reel / Short — `../reels/v05-setup-demolished.mp4`
> Caption: "Your AI says 'looks done.' It shipped a 401. We fixed the part *before* Iris works — one pasted line. v0.5.0 is live. ⭐ github.com/syrin-labs/iris"

---

## DAY 2 — "100 developers, one pasted line"

### X / Twitter
**Card:** `proof-100-square.png`

> 36 hours ago we shipped Iris v0.5.0. ~100 developers have it running.
>
> The #1 reply isn't about a feature. It's: *"wait — that was the whole setup?"*
>
> Yes. That was the whole setup.
>
> ⭐ github.com/syrin-labs/iris

### X / Twitter — testimonials (3-image tweet)
**Cards:** `testimonial-1.png`, `testimonial-2.png`, `testimonial-3.png`

> What devs are saying about the one-line setup in v0.5.0 👇

### LinkedIn — testimonials
**Card:** `testimonial-1.png` (or all three as a carousel)

> 48 hours after launch, here's what the early v0.5.0 users are telling us 👇
>
> 💬 "First verdict in under a minute. I genuinely sat there for a second." — Maya R., full-stack dev
> 💬 "We had a homegrown script just to keep the daemon alive. v0.5.0 made it obsolete in one line." — Daniel F., staff engineer
> 💬 "It caught a 401 my agent had confidently marked as fixed." — Tom A., indie hacker
>
> The pattern: it's not that we added something dazzling. It's that we got out of the way.
>
> Try it (MIT, dev-only): github.com/syrin-labs/iris

### Instagram — carousel
**Cards:** `proof-100-square` → `testimonial-1` → `2` → `3` → `cta-wide`
> 100 developers in one day. Same reaction every time 👇 Swipe → real reactions to the one-line setup.
>
> ⭐ github.com/syrin-labs/iris · link in bio

---

## DAY 3 — "Watch it work"

### X / Twitter — demo
**Clip:** a cut from `assets/clips/iris_full_run.mov` (or `iris_login_redeploy_action.mov`)

> This is the whole loop. Agent builds a login → Iris drives its own browser → `iris_assert` → **pass:false, POST /login 401** → one-line fix → **pass:true.**
>
> No screenshot. No guessing. A verdict, with evidence.
>
> v0.5.0 → github.com/syrin-labs/iris

### LinkedIn — the "why it matters" close
**Card:** `cta-wide.png`

> The most expensive bug is the one your AI says it already fixed.
>
> A screenshot can be misread. An agent that marks its own homework will tell you "done" and ship a silent 401.
>
> Iris closes that gap: it verifies from *inside* your running app and returns pass/fail + evidence — and on React, the exact file:line to fix.
>
> With v0.5.0 there's no excuse not to try it: one pasted line and you're running.
>
> ⭐ github.com/syrin-labs/iris — MIT, dev-only, no telemetry.

### Instagram — feed (`cta-wide.png`)
> "Looks done" is not a test. Give your AI agent eyes. v0.5.0 is the easiest it's ever been — one pasted line.
>
> ⭐ github.com/syrin-labs/iris (link in bio)

---

## Testimonials (fictional — clearly invented personas for promo use)

> ⚠️ Illustrative, made-up testimonials for creative mockups. Swap for real quotes before any paid placement.

- **Maya R. · @maya_builds · full-stack dev** — "First verdict in under a minute. I sat there for a second — *that* was the whole setup?"
- **Daniel F. · @dffrential · staff engineer** — "We had a script just to keep the daemon alive. v0.5.0 deleted it in one line."
- **Tom A. · @tomwritescode · indie hacker** — "It caught a 401 my agent swore was fixed. That moment sold me."
- **Priya N. · @priyaships · frontend lead** — "Presenter mode is unfairly good in pairing sessions — I can *watch* what it's checking."
- **Leo K. · @leokdev · platform eng** — "`--drive` means it stops fighting my browser tab. Just runs. Finally."

---

## Reusable CTA lines

- ⭐ Star it: **github.com/syrin-labs/iris**
- One-line setup: paste `Follow https://raw.githubusercontent.com/syrinlabs/iris/main/SKILL.md`
- MIT · dev-only · localhost-only · no telemetry
- *Give your agent eyes.*
