# dsh-context-redline (Context Redline)

> A **DeepSeek Harness plugin** that turns the context panel from a **read-only dashboard** into a
> **workbench a human can redline** — and wires **edit → snapshot → child session → compaction →
> parent-steers-child** into one workflow, to fight both **context bloat** and **instruction drift**.

**Status: documentation only — no code yet.** The repository is at **M0 (docs first)**:
scope, platform facts, architecture, UI spec, roadmap and test plan are written; implementation starts
only after review and sign-off. Rationale: agreeing on *what* to build, *on what evidence* and
*what "done" means* is far cheaper than writing code first and explaining it afterwards.

---

## What it solves

| Problem | Symptom | Answer |
|---|---|---|
| **Context bloat** | every request resends the whole history; sessions grow without bound | **Snapshot + child session**: a clean, short starting point |
| **Injection drift** | the harness re-injects `runtime-context` / AGENTS.md / skill catalog every turn, so a human edit comes back next turn | **Verbatim pinned blocks + drift check + explicit re-inject** |
| **Nothing is editable** | the upstream context browser can only be read | **Edit on the right**, with "which item, what changed, did it take effect" always visible |

**In one line**: a snapshot cuts off the *past*, pinned blocks guard the *future*, and editing fixes the *present*.

## What it looks like

The shell comes **entirely from upstream [`dsh-context`](https://github.com/bowenliang123/dsh-context) v0.59.2**
(the panel you already run). What we add on top is **editing** and **orchestration**:

- **Left**: turn bars carry `user msgs N · injected N`; clicking a turn drives the right panel to that turn's last step.
- **Right**: the category accordion (system prompt / tool schemas / user messages / injected content /
  skill injection / assistant messages / tool results). Each row shows `#seq` plus actions:
  **Edit** (shadow the original) / **Annotate** (keep the original + a void range) /
  **Pin as invariant** / **Apply to session**. The editor expands **inline under that row** (never a modal),
  and is prefilled with the **full text**. A sticky banner shows "N changes not yet applied".
- **Below**: snapshots and child sessions (freeze → fork → compact → dispatch / status / interrupt).

## Four rules a user must grasp at a glance

1. Only what is **on the surface** reaches the model.
2. Two kinds of change, different consequences:
   - **Edit = shadow the original** — the model never sees it again (the original stays in the log, and **you can roll back**).
   - **Annotate = keep the original** — append a correction with an explicit *void range*; the model sees both.
3. Every change is **two steps**: save a draft (local, **not yet in effect**) → **apply to session** (actually writes).
4. **What is editable is decided by the platform, not by preference** (measured):
   - Editable: **user messages**, injected content, skill injection (when the underlying event is a user/tool event), tool results.
   - **Not editable: assistant messages** (two platform rules are mutually exclusive) → annotate only, and the UI says why.
   - **Repeat edits and rollback both work** via version history — it is *not* a one-shot operation.

## Explicitly out of scope

- ❌ No "delete history" (the DSH session log is append-only; only **shadowing** and **compaction** exist — the latter irreversible).
- ❌ No auto-fork, no auto-re-inject, no auto-apply of drafts.
- ❌ No **AI-generated content** anywhere. This is the project's reason to exist: every character that reaches the model is human-written.
- ❌ No "context assembly / templates / extends" layer in this round (a different data model — see [`docs/00`](docs/00-scope.md) §4).

---

## Documentation index

| File | Content |
|---|---|
| [`docs/00-scope.md`](docs/00-scope.md) | Goals / non-goals / user stories / **acceptance criteria** / glossary |
| [`docs/01-platform-facts.md`](docs/01-platform-facts.md) | **Platform facts**, each with a source and a `measured` / `inferred` tag, plus open verification items |
| [`docs/02-architecture.md`](docs/02-architecture.md) | Five layers, two data flows, module layout, RPC / command / service surface, storage |
| [`docs/03-ui-spec.md`](docs/03-ui-spec.md) | **UI spec**, numbered requirements, exact copy, acceptance checklist, explicit non-goals |
| [`docs/04-roadmap.md`](docs/04-roadmap.md) | Stages M0–M7 (deliverables / tests / **who accepts** / **authorization gates**) |
| [`docs/05-test-plan.md`](docs/05-test-plan.md) | Test lanes, real-route test pattern, human-gate checklist, failure-mode cases |
| [`docs/06-orchestration.md`](docs/06-orchestration.md) | Snapshot / fork / compaction / dispatch semantics, authorization list, error-code mapping |
| [`docs/08-open-questions.md`](docs/08-open-questions.md) | **Questions to settle** (each with a recommendation) + the external-model review log |
| [`docs/09-requirements-traceability.md`](docs/09-requirements-traceability.md) | **Requirement traceability**: every original request and every capability from the WeChat screenshots → which goal → done / not done / downgraded |
| [`demo/`](demo/README.md) | **Clickable interaction prototype** (M0.5 gate): fake data, real interactions, and a "what does this button do" explain mode |

> **Numbering note**: `docs/07` used to be the audit of the earlier attempt; it was deleted on 2026-09-30 at the user's request. **The number is not reused**, to avoid confusion with historical references.

| [`AGENTS.md`](AGENTS.md) | Working agreement: hard constraints, platform pitfalls, testing discipline |
| [`UPSTREAM.md`](UPSTREAM.md) / [`NOTICE`](NOTICE) | Upstream provenance, license compliance, list of our modifications |

*(The numbered docs are written in Chinese — the project's working language. Ask if you need a translation for review.)*

## How to review

1. [`docs/00-scope.md`](docs/00-scope.md) §2 (non-goals) and §3 (acceptance criteria) — *is this the right thing to build?*
2. [`docs/01-platform-facts.md`](docs/01-platform-facts.md) — *is the evidence real?* (note §6, the deliberately unverified items)
3. [`docs/03-ui-spec.md`](docs/03-ui-spec.md) and [`docs/06-orchestration.md`](docs/06-orchestration.md) — *is the human/irreversibility story honest?*
4. [`docs/08-open-questions.md`](docs/08-open-questions.md) — *rule on a specific numbered question.*

## Install / usage

Not available yet: M0 produces docs only. Once M1 lands, this section will carry the
`dsh plugin --profile web add` steps and the verification path (a client-side change needs only a hard
refresh — no `dsh web` restart).

## License

This project is **MIT** ([`LICENSE`](LICENSE)); the portions copied from upstream `dsh-context` are
**Apache-2.0** (verbatim in [`LICENSE-Apache-2.0`](LICENSE-Apache-2.0); provenance and modification list in
[`UPSTREAM.md`](UPSTREAM.md)). This is an independent fork, **not affiliated with or endorsed by** the
upstream author.

## About the earlier attempt

This repository previously carried an earlier line built on upstream `v0.59.0` (during 2026-09). **Its directory and git
history are gone**, and the audit document was deleted at the user's request. This line re-forks from tag `v0.59.2`;
**only the "don't repeat these" conclusions survive**, kept in [`docs/01`](docs/01-platform-facts.md) and
[`AGENTS.md`](AGENTS.md) §2.
