# Maintenance guide

## Product contract

`dsh-context-redline` is a DeepSeek Harness plugin that:

1. reads the selected session's current context through public Session Query services;
2. stores edits and delete marks only in the plugin data directory;
3. opens a zero-history ordinary root session in the same workspace with the exact confirmed text and per-session model configuration, or creates an independent anchored conversation (first task + frozen goal/acceptance/discipline runtime snapshot) with no migration and no return;
4. returns the task-bound result verbatim to the source session;
5. optionally audits one anchored conversation with an opt-in Goal Guard: a frozen goal card (goal/acceptance/discipline/task list hash) plus an independent evaluator call, presented as a status card. In 0.9.0 the guard is OBSERVE-ONLY — it records verdicts and correction suggestions and must never block a tool, steer a session, or end a turn.

The source session log is append-only and is never rewritten or deleted. A deleted item means “do not migrate this item.”

## Hard constraints

- Modify only this repository unless the user explicitly authorizes another scope.
- Never restart production `dsh web`; the user performs every production restart.
- Do not commit, push, tag, publish, install, or change profile configuration without separate authorization.
- Do not write a real session except through the user's confirmation dialog.
- Do not run `scripts/clean-lib.mjs`; linked profiles require the built client bundle to remain present.
- Preserve `LICENSE-Apache-2.0`, `NOTICE`, and `UPSTREAM.md`.
- Read session content through `sessionQuery`; deprecated synchronous Session reads are forbidden for new code.
- Editor prefill must use full durable text, never the shortened list preview.
- Raw `agent.followup` does not deduplicate request IDs. Fixed IDs, durable ledgers, exact byte comparison, cold-read verification, and plugin locks are required.
- Recovery has three outcomes: exists / absent / unknown. Retry only on definite absence.
- System prompts and tool definitions are owned by the selected preset. Migrated prose must never pretend to modify those platform layers. The opt-in carrier runtime rule, the anchored conversation snapshot and the goal-guard status context are separate, user-reviewed runtime contexts (`systemPrompt.context`) for the carrier/anchored session only — never a preset section or tool definition.
- The goal guard is per-session, opt-in and observe-only in 0.9.0: no tool guard, no steering, no turn stopping. The blocking path (tool denial, turn-stopping audit, attempt/steer caps, final audit) may only be enabled by an explicit later-version change, never by a default.
- The evaluator receives only the frozen goal card, the current task and a bounded candidate excerpt; it never receives the full session history, and an evaluator failure is `insufficient`, never `pass`.

## Current media policy

- Mixed text/image messages migrate their text and report the number of omitted image blocks.
- Pure-image messages do not create fabricated empty migration paragraphs.
- Image identities remain part of the source fingerprint.
- File, file-ref, and generic attachment blocks are rejected until durable attachment migration is implemented.

## Development discipline

- Use TDD for behavior changes: failing assertion → minimal implementation → green → adversarial/negative case → full gates.
- Keep host and client error details observable; do not collapse actionable failures into generic copy.
- When implementation and documentation disagree, the repository behavior and the user's latest instruction win; update both English and Chinese README files together.
- Stop automation while waiting for user visual/manual acceptance. Do not create continuation goals merely to poll for a user action.

## Required verification

```bash
pnpm install
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/oxlint
./node_modules/.bin/tsdown
./node_modules/.bin/vitest run --project edit --project channel --project client-logic --project client-ui
./node_modules/.bin/vitest run
node scripts/check-docs.mjs
node scripts/check-workflows.mjs
node scripts/namespace-contract.mjs
node scripts/css-closure.mjs
node scripts/i18n-orphans.mjs
node scripts/check-package.mjs
node demo/check-static.mjs
node demo/check-runtime.mjs
node scripts/check-release-ready.mjs
node scripts/release-check.mjs
pnpm pack --dry-run
```

For optional composition verification:

```bash
dsh --profile web --dump-config
```

## Current documentation

- `README.md` / `README.zh.md`: product overview, install, usage, limitations.
- `docs/12-user-guide.md`: user workflow and troubleshooting.
- `docs/13-context-migration.md`: source identity, migration, image omission, and final-byte rules.
- `docs/14-system-prompt-and-injection.md`: platform-owned prompt/tool boundaries.
- `docs/15-carrier-lifecycle.md`: durable operation, creation, recovery, result attribution, and return lifecycle.
- `docs/16-goal-guard.md`: the observe-only goal guard — scope, frozen goal card, task ledger, evaluator contract, storage, limits, and the boundaries that keep 0.9.0 observational.
- `UPSTREAM.md`: provenance and Apache-2.0 modification record.
