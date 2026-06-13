# COMMIT.md — Pre-Commit Checklist

`pre-commit.sh` automates most of this. Run through it before committing.

## Safety

- [ ] No secrets / API keys / tokens in the diff
- [ ] No `plan/` files staged (research never ships)
- [ ] No `.env` staged (only `.env.example`)
- [ ] No `any` types introduced
- [ ] No `console.log` (use `console.warn`/`console.error`, or structured logging in the server)
- [ ] No file over 500 lines
- [ ] No component file prefixed `new-` (use `create-`)
- [ ] Every `eslint-disable` has a `// reason` comment above it

## Quality gates (all must pass)

- [ ] `pnpm format:check` clean
- [ ] `pnpm lint` clean
- [ ] `pnpm typecheck` clean
- [ ] `pnpm test:unit` green

## Design & contract

- [ ] No hardcoded design values (colors/spacing/fonts come from `tokens.ts`)
- [ ] No free strings (constants in `protocol` / `tool-names` / demo `constants/`)
- [ ] Wire-format changes went through `@iris/protocol` (constant + zod schema) first
- [ ] New/changed behavior has a failing-then-passing test

## Conventions

- [ ] Files kebab-case, types PascalCase, constants `as const`
- [ ] No `useX` function that doesn't call a React hook
- [ ] Package stayed in its lane (browser DOM-only, server Node-only)
