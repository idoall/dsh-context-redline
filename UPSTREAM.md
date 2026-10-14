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

### Tests and tooling

The fork adds independent edit/channel/client logic/client UI lanes, namespace and CSS isolation checks, i18n orphan detection, demo rendering checks, release readiness checks, and a consolidated release gate.

## Files intentionally retained from upstream

The repository still contains adapted upstream layout, projection, rendering and utility modules. File headers and Git history identify exact changes; this provenance file and `NOTICE` are included in every package tarball.
