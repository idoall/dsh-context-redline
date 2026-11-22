# Upstream provenance and modifications

## Source

| Field | Value |
|---|---|
| Upstream repository | `https://github.com/bowenliang123/dsh-context` |
| Copied baseline | tag `v0.59.2`, commit `fc44fff9548d404da3c4935525d01b5e4fb62517` |
| Upstream license | Apache-2.0 |
| Preserved license | `LICENSE-Apache-2.0` |
| Notice | `NOTICE` |

The npm package did not ship source, so the baseline was copied from the tagged Git repository. This project is an independent fork and is not endorsed by the upstream author.

## License compliance

- Apache-2.0 notices and the original license are retained.
- `package.json` declares `MIT AND Apache-2.0`.
- Original project code is MIT; copied/derived upstream portions remain Apache-2.0.
- This file records the material modification categories.

## Material modifications

### Independent identity

All global identities were separated from `dsh-context` so both plugins can coexist:

- package and bundle ID: `dsh-context-redline`;
- HTTP route prefix: `/api/dsh-context-redline/*`;
- projection keys: `redline*`;
- conversation view ID: `redline`;
- locale/message/storage/localStorage namespaces: `dsh-context-redline`;
- CSS/data prefixes: `redline-*` / `data-redline-*`.

### Product behavior

The upstream read-only context panel was extended with:

- full-text reads through Session Query;
- plugin-local editing and reversible delete marks;
- editable migration copies for supported event roles;
- stable source identities and role-preserving migration manifests;
- final-message editing and per-carrier model/reasoning selection;
- ordinary zero-history root sessions in the current workspace;
- durable operation ledgers, fixed IDs, cold-read verification and recovery;
- task-bound automatic verbatim return to the source session;
- explicit mixed-image omission reporting without blocking text migration.

Legacy fork/subagent creation remains only as a zero-write refusal for stale clients; the product path uses `carrier.plan`, `carrier.start`, and `carrier.list`.

### UI and styles

The Client UI was substantially changed:

- renamed and isolated every component/style namespace;
- added inline editors, delete states, carrier confirmation and carrier index;
- added a compact floating model/reasoning picker;
- retained the context statistics/trend/browser foundation while removing unrelated upstream features;
- added light/dark theme-token and CSS-closure safeguards.

### Host and persistence

New Host modules under `src/host/redline-*` and pure modules under `src/redline` / `src/shared/redline-*` implement source capture, manifests, strict ledgers, ordinary-session control, result attribution, recovery and return delivery.

### DSH 0.2.2 compatibility (0.1.1, 2026-11-04)

- Await Host projection registration and retain a ready handle for detail reads.
- Read the Agent's current Session-local model selection for carrier previews and recovery validation, and the recorded preset selection; do not modify source selections.
- Preserve direct tool-result message content and error metadata in the Client history mapper, alongside legacy wrapped results.
- Raise the supported baseline to DSH 0.2.2-rc.1 / Node.js 24.9 and synchronize release metadata and dependency contracts.
- Keep unpublished diagnostics and carrier-seed experiments outside this maintenance release.

### DSH 0.2.2-rc.4 compatibility (0.1.2, 2026-11-18)

- Move the verified baseline to DSH 0.2.2-rc.4, Zod 4.6.6 and the new `dsh-error` peer; recheck Session Query, Agent, preset, workspace, projection and Client slot contracts.
- Keep the 0.1.1 behavioral fixes and the unpublished diagnostics/carrier-seed work outside this maintenance release.

### DSH 0.2.2-rc.5 compatibility (0.1.3, 2026-11-21)

- Move the verified baseline and dependency floors to DSH 0.2.2-rc.5 (npm `latest`); recheck the public contracts this plugin uses.
- Keep the earlier behavioral fixes and the unpublished diagnostics/carrier-seed work outside this maintenance release.

### Head-and-tail anchor (0.2.0, 2026-11-21)

- Add an optional human-written anchor mirrored at the start and end of the carrier's first message; it is fingerprinted with the task and never touches preset-owned prompt layers.
- Keep the 0.1.1–0.1.3 compatibility fixes and the unpublished diagnostics/carrier-seed work outside this release.

### Runtime-rule anchor (0.3.0, 2026-11-21)

- Add an opt-in per-request runtime rule for the carrier via `systemPrompt.context`, alongside the 0.2.0 first-message anchor; both are user-written, fingerprinted and frozen in the ledger.
- The rule is never a preset system-prompt section or tool definition, and never touches the source session.

### Anchored conversation (0.4.0, 2026-11-22)

- Add an independent root conversation that carries a frozen goal/acceptance/discipline runtime snapshot without migrating context or returning a result.
- Keep the 0.1.x–0.3.0 fixes, both anchor modes and the unpublished diagnostics/carrier-seed work outside this release.

### Anchored-conversation fixes (0.4.1, 2026-11-22)

- Bounded post-flush re-reads for prompt persistence (query projection lag) and dialog footer spacing; no product-semantics change.

### Trend duration overlay (0.5.0, 2026-11-22)

- Port the reference trend chart's per-step active-time overlay (`activeMs`), merged title modifiers, focused-category subtitle removal and the hover-path performance fix into the `redline-` namespace; no upstream-only cards or DNA mode are imported.

### Trend DNA mode (0.6.0, 2026-11-22)

- Port the reference trend chart's per-item DNA gradient into the `redline-` namespace and share the browser's DNA switch through controlled props. DNA + Delta and band click-through are deliberately out of scope; the reference plugin's fixed blocks/team entry are not imported.

### DNA switch state fix (0.6.1, 2026-11-22)

- Keep the trend's Total/Delta state consistent when DNA is toggled from the Context browser; no feature or data change.

### Handoff skill (0.7.0, 2026-11-22)

- Add an optional runtime skill that drafts the four anchored-conversation fields from the current conversation; registered only when the host has a skills registry.

### Two handoff shapes (0.8.0, 2026-11-22)

- Extend the optional handoff skill to cover both the migration fields and the anchored-conversation fields, with one shared goal/acceptance/discipline quality gate.

### Handoff rules and title cleanup (0.8.1, 2026-11-22)

- Drop the generic title prefix from anchored sessions and embed role separation plus conditional headed UAT into the optional handoff skill.

### Tests and tooling

The fork adds independent edit/channel/client logic/client UI lanes, namespace and CSS isolation checks, i18n orphan detection, demo rendering checks, release readiness checks, and a consolidated release gate.

## Files intentionally retained from upstream

The repository still contains adapted upstream layout, projection, rendering and utility modules. File headers and Git history identify exact changes; this provenance file and `NOTICE` are included in every package tarball.
