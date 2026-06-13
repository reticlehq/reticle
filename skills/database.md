# skills/database.md — Persistence

**Open when:** adding any persistence. (Foundation II.12 — mostly N/A today.)

## Current state: no database

Iris is in-memory by default. Ring buffers live in the bridge process and are never
persisted. This is deliberate (privacy: nothing leaves the machine unless explicitly saved).

## The only persistence Iris plans (M3+)

**Baselines and recordings**, written to a local `.iris/` directory (gitignored) only when
the agent explicitly calls `baseline_save` / `record_start`. Design:

- Format: JSON files keyed by name (`.iris/baselines/<name>.json`,
  `.iris/recordings/<name>.json`). No server, no DB engine for v1 — these are small, local,
  single-user artifacts.
- Each baseline stores the semantic snapshot + counters + a schema `version` field so future
  formats can migrate.
- If volume ever demands it, graduate to SQLite (single-file, embedded) — **not** a hosted
  DB. Iris is a dev tool; keep persistence local and zero-config.

## If/when a real DB is introduced

Apply Foundation II.12 in full: UUID v7 PKs for anything exposed, `TIMESTAMPTZ` not
`TIMESTAMP`, money as integer cents, constraints express business rules, index every FK,
`EXPLAIN ANALYZE` before/after, zero-downtime migrations, RLS for any multi-user data.
Until that day: **this is the whole guide.** Keep it local, keep it JSON.
