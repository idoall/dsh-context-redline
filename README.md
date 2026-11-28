<h1 align="center">Context Redline</h1>

<p align="center">Inspect, redline, and migrate DeepSeek Harness context, then return the bound task result verbatim.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-context-redline"><img src="https://img.shields.io/npm/v/dsh-context-redline?label=npm&color=CB3837" alt="npm version"></a>
  <a href="https://github.com/idoall/dsh-context-redline/actions/workflows/ci.yml"><img src="https://github.com/idoall/dsh-context-redline/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/idoall/dsh-context-redline/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT%20AND%20Apache--2.0-0F172A" alt="License"></a>
</p>

<p align="center">English | <a href="https://github.com/idoall/dsh-context-redline/blob/main/README.zh.md">中文</a></p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#install">Install</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#boundaries">Boundaries</a> ·
  <a href="https://github.com/idoall/dsh-context-redline/blob/main/CHANGELOG.md">Changelog</a>
</p>

> A DeepSeek Harness community plugin. It does not modify DSH source or rewrite the source session log.
>
> **Version `0.10.0` — supports DSH `>=0.2.3-alpha.2 <0.3.0-0`.** Built and regression-tested against `0.2.3-alpha.2`; Node.js `^24.22.3 || >=26.13.1` is required. DSH `0.3.0` prereleases are excluded.

Edits stay local until confirmation. The plugin then opens a zero-history ordinary session in the current workspace and sends the exact final message you approved. When the task finishes, its bound result returns verbatim to the source session.

<p align="center">
  <img src="https://raw.githubusercontent.com/idoall/dsh-context-redline/main/assets/overview.png" width="100%" alt="Context Redline desktop overview: statistics, trend, events, seven context categories, and carrier sessions">
</p>

<p align="center"><sub>Current interactive demo, desktop: context scale and events on the left; review, edit, delete, and carrier controls on the right.</sub></p>

## Features

- **Full durable text.** Editors read the complete event body, never the shortened list preview.
- **Local redlining.** Edit user messages, injected/skill material, assistant migration copies, and paired tool results.
- **Reversible deletion.** Delete means “do not migrate this identity”; the source log remains append-only.
- **Authoritative final message.** The confirmation textarea is the exact first user message written to the new session.
- **Handoff skill.** The plugin contributes a runtime skill, `context-redline-handoff`: it reads the current conversation and outputs both handoff shapes — the migration fields (first task + per-request rule anchor) and the anchored conversation fields (first task, goal, acceptance criteria, discipline), with mandatory task decomposition, role separation, and conditional headed UAT. It also always emits the optional supervised-run package, so the user decides whether to check it: a four-column task table (id, title, acceptance, and the required scope the task may modify), probe commands, and an explicit recommendation with a reason for every run option — session execution model and reasoning effort, evaluator model and reasoning effort, executor and evaluator fallback models, the visual-evidence toggle and its multimodal witness model, strict mode, and isolated worktree — never inventing provider/model names.
- **Anchored conversation without migration.** Starts an independent root conversation from a task plus a frozen runtime snapshot of goal, acceptance criteria and discipline. Nothing is copied from the current session and no result is returned to it.
- **Supervised runs (0.9 beta).** An anchored conversation can opt into a supervised run. The confirmed goal, acceptance criteria, discipline and task table freeze into the run directory (`docs/guard/<run-id>/`), where `tasks.json` is the only source of truth, `state.jsonl` is append-only and `TASKS.md` is the rendered page the human reads. After each turn the plugin audits the session: it runs the task's deterministic probes itself (the model never does), has an independent evaluator (following the main session by default, or an explicitly selected model for a second opinion) judge the task against the frozen card, and commits a passing task — exactly its declared paths plus the ledger — before tagging it `guard/<run-id>/<task>`. The head and tail anchors are re-rendered from the ledger every turn, so a compacted history cannot drift from the task actually running. A long run never dies on the host's 256-round default: the plugin arms the goal with a large round budget and rolls it forward while progress continues. Conversely, a task whose probes all pass but which produces neither a code change nor a new completion declaration for several turns is treated as spinning and blocked automatically, so rounds go to real work. The card reads both the ledger and the live host goal: when the goal stopped at its round limit or is disarmed, the card says so (`blocked` / `paused`) and offers Continue instead of rendering a dead run as running. Strict mode additionally denies writes outside the task's scope and every shell tool. Model roles are split into **executor and evaluator chains, each with a primary and an optional fallback (both carrying a reasoning level)**: the judge switches to its fallback on empty replies, timeouts or rate limits and records `eval.fallback`; quota/auth failures stay visible, and only cross-provider quota exhaustion may switch. A blocked run offers **Continue**, **Switch executor fallback and continue**, and **Switch evaluator fallback and continue**. Optional **visual evidence** is observation-only: a vision model lists findings on the task's changed screenshots and the text judge decides; an unavailable witness can never yield a pass. A blocked task stops the run with its patch kept as evidence; rollback reopens the task and is a two-step confirmation. Known limits are documented rather than implied: parallel tasks share one run worktree, an isolated worktree is not merged back automatically, and the run is only as trustworthy as the probes you give it.
- **DNA fingerprint mode.** The trend bars can switch to a per-item gradient in the model’s read order; the browser’s DNA switch and the trend switch move together. DNA currently forces total semantics.
- **Trend duration overlay.** Each trend bar carries its step’s active time as a curve read off the right-hand axis; turn mode sums the turn’s steps. The Adaptive and Duration modifiers share one compact toggle group, and the old focused-category subtitle is gone.
- **Anchor with two modes.** An optional short anchor, written by you, can be repeated at the start and end of the first message, or supplied as a per-request runtime rule. The runtime mode uses DSH's runtime-context snapshot: unchanged text is not rewritten, and after compaction it is re-declared with a supersession notice. Neither mode touches the preset-owned system prompt or the source session.
- **Per-session model selection.** A compact floating picker configures only the carrier Agent and never changes the source/global default.
- **Ordinary zero-history session.** The carrier is a root session in the current workspace, not inherited fork history.
- **Automatic verbatim return.** Only the result bound to the fixed prompt request is returned.
- **Crash recovery.** Fixed IDs, strict ledgers, exact-content matching, flush, cold reads, and three-state recovery prevent guessing and duplicate sends.

<p align="center">
  <img src="https://raw.githubusercontent.com/idoall/dsh-context-redline/main/assets/carrier-confirm.png" width="100%" alt="Open ordinary session confirmation: task, model and reasoning effort, and exact final message">
</p>

<p align="center"><sub>Desktop confirmation: task, model/effort, and the final message freeze in one explicit authorization.</sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/idoall/dsh-context-redline/main/assets/mobile-confirm.png" width="430" alt="Mobile ordinary-session confirmation">
</p>

<p align="center"><sub>Mobile confirmation: model and effort stay on one row; long content scrolls inside the final-message editor.</sub></p>

> Screenshots come from the current interactive demo and illustrate layout and the product flow; they are not presented as production session data.

## Install

Requires DeepSeek Harness `0.2.3-alpha.2` or a newer supported `0.2.x`, plus Node.js `24.22.3+` (or `26.13.1+` on the 26.x line). Older DSH installations should stay on plugin `0.8.4` until upgrading DSH.

Install or upgrade to this exact release:

```sh
dsh plugin --profile web add dsh-context-redline@0.10.0
```

This release makes the observe-only guard usable as a progress signal and adds the first short-anchor layer. The guard no longer short-circuits when the main session writes its own plan or review records: it always runs the evaluator, hands it the written paths (not just a tool count), records the verdict and advances the ledger on a pass. The guard card now says when an audit did not run and why, instead of showing a stale failure. On top of the full goal card, a SHORT invariant block is re-injected at the head and the tail of every prompt — goal hash, the current task and its acceptance, the hard rules and the stop conditions, refreshed from live state — so the rules that must not drift survive the context window and compaction. Guard behaviour is still observe-only.

Local development:

```sh
pnpm install
pnpm run build
dsh plugin --profile web add "link:$(pwd)"
```

The user must restart `dsh web` after installation or Host changes. A rebuilt Client-only change normally needs only a hard refresh.

Remove:

```sh
dsh plugin --profile web remove dsh-context-redline
```

Uninstalling does not automatically delete local drafts and operation ledgers under `$DSH_HOME/dsh-context-redline/`.

## Usage

1. Open a session with messages and select **Context Redline**.
2. Optionally edit/delete individual items; saves remain local.
3. Choose **Open ordinary new session**.
4. If you are not sure what to fill, run the `context-redline-handoff` skill first; it recommends migration or a fresh anchored conversation and outputs the matching fields. The snapshot is frozen before creation and re-declared after compaction.
5. In the migration flow, enter the task; optionally add a short anchor (keywords or hard constraints) and choose **first message** or **runtime rule**, then finish the exact final message.
6. Choose a model; keep effort at **Use model default** unless needed. In an anchored conversation, optionally enable **Supervised run**: paste the four-column task table and probe commands; checking it moves the session execution model into the options panel, right before its executor fallback (unchecked, it stays in the runtime section below), where you can optionally pick an independent evaluator model, executor/evaluator fallback models, enable visual evidence with a multimodal witness, and decide whether to enable strict mode or an isolated worktree (`<workspace>/.guard/worktrees/<runId>` on branch `guard/<runId>`, locally git-ignored so it never enters a commit, and deliberately **not** registered as a DSH workspace — the session stays grouped under the current workspace while only its working directory moves to the checkout). When the workspace is a git repository the dialog pre-selects that isolated worktree (you can turn it off; turning it off on `main`/`master` warns that supervised commits will land there).
7. Confirm creation and open the new session from the left sidebar.
8. In the migration flow, the bound result returns automatically after completion.

See the [user guide](https://github.com/idoall/dsh-context-redline/blob/main/docs/12-user-guide.md).

## Images and attachments

- Mixed text/image messages migrate all text and report omitted images.
- Pure-image messages do not create fabricated empty paragraphs.
- Image identities remain in the source fingerprint, so changes invalidate confirmation.
- Image binaries, files, file refs, and generic attachments are not migrated yet; unknown media refuses instead of disappearing silently.

## Boundaries

- Never rewrites or deletes source history.
- System prompts and tool schemas come from the target preset; migrated prose never pretends to alter those layers.
- Tool results require a matching call identity.
- No history/version UI, rollback, compaction, team task board, or session deletion UI.
- A supervised run's strict mode is **opt-in and off by default**: only a confirmed strict run denies out-of-scope writes and shell tools; otherwise the run records verdicts and commits passing tasks without denying anything.
- The plugin provides lock-scoped idempotence and recovery; it does not claim platform-native exactly-once delivery.

## Development

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
./node_modules/.bin/vitest run
node scripts/release-check.mjs
pnpm pack --dry-run
```

Pushing a `v*` tag runs the version and bilingual-release-note gate, tests, package creation, npm Trusted Publishing over OIDC (no `NPM_TOKEN`), and GitHub Release creation.

## Documentation

- [User guide](https://github.com/idoall/dsh-context-redline/blob/main/docs/12-user-guide.md)
- [Context migration contract](https://github.com/idoall/dsh-context-redline/blob/main/docs/13-context-migration.md)
- [System prompt and injection boundaries](https://github.com/idoall/dsh-context-redline/blob/main/docs/14-system-prompt-and-injection.md)
- [Carrier lifecycle](https://github.com/idoall/dsh-context-redline/blob/main/docs/15-carrier-lifecycle.md)
- [Goal supervisor design](https://github.com/idoall/dsh-context-redline/blob/main/docs/17-goal-supervisor-design.md)
- [Upstream provenance and modifications](https://github.com/idoall/dsh-context-redline/blob/main/UPSTREAM.md)

## License

Original work is MIT; portions copied from `dsh-context` remain Apache-2.0. See [LICENSE](https://github.com/idoall/dsh-context-redline/blob/main/LICENSE), [LICENSE-Apache-2.0](https://github.com/idoall/dsh-context-redline/blob/main/LICENSE-Apache-2.0), [NOTICE](https://github.com/idoall/dsh-context-redline/blob/main/NOTICE), and [UPSTREAM.md](https://github.com/idoall/dsh-context-redline/blob/main/UPSTREAM.md). This is an independent fork and is not endorsed by the upstream author.
