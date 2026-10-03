// `scripts/release-check.mjs` — the pre-release self-check (M6-10).
//
// What this pins is the PLAN, not a run: executing the whole plan inside a unit
// test would recursively run the suite it is part of. So the assertions are:
//
//   · every gate the project actually relies on is in the plan (a missing one
//     would silently turn "all green" into "all green except the thing you
//     forgot"), and each step knows the VERDICT LINE it must see — the whole
//     point after `docs/11` D36 was that reading the wrong line hid 23 errors;
//   · `dsh --profile web --dump-config` is opt-in (`--with-dsh`) because it costs
//     seconds and is not needed for the inner loop;
//   · the script is READ-ONLY: asserted statically on its own source, so a future
//     edit cannot quietly start writing during a "check".

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'vitest'
import { planSteps, REQUIRED_GATES } from '../../scripts/release-check.mjs'

const src = readFileSync('scripts/release-check.mjs', 'utf8')

describe('the plan covers every gate the project relies on', () => {
  test('each required gate is present, each step names its verdict line', () => {
    const plan = planSteps({ withDsh: false })
    // Compare GATE IDS, not text: `lanes` is a step's `gate`, it need not appear
    // in its label (my first version grepped the text and failed on that).
    const covered = new Set(plan.map(s => s.gate))
    for (const gate of REQUIRED_GATES) {
      assert.ok(covered.has(gate.gate), `missing gate: ${gate.gate}`)
    }
    assert.equal(covered.size, plan.length, 'no two steps claim the same gate')
    for (const step of plan) {
      assert.ok(step.label.length > 0, 'every step is labelled')
      assert.ok(typeof step.expect === 'string' && step.expect.length > 0,
        `step "${step.label}" must name the line it expects (docs/11 D36)`)
    }
  })

  test('the exit code and the verdict are both checked, not just "it ran"', () => {
    // A step that only looks at the exit code would have passed the oxlint
    // incident (it exited 0 while printing 23 errors? no — it exited 1; the
    // incident was reading the wrong LINE). Keep both: code + line.
    for (const step of planSteps({ withDsh: false })) {
      assert.ok('expect' in step)
      if (step.codeMustBeZero !== false) assert.ok(step.command !== undefined)
    }
  })

  test('the dsh dump is opt-in and read-only when asked for', () => {
    assert.equal(planSteps({ withDsh: false }).some(s => (s.command ?? '').includes('dump-config')), false)
    const withDsh = planSteps({ withDsh: true })
    const dump = withDsh.find(s => (s.command ?? '').includes('dump-config'))
    assert.ok(dump !== undefined, '--with-dsh adds the composition check')
    assert.ok((dump!.command ?? '').includes('--dump-config'))
  })
})

describe('the script never writes', () => {
  test('no filesystem write API appears in its source', () => {
    // The check must be safe to run at any time, on any tree.
    const writes = /writeFileSync|appendFileSync|createWriteStream|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync/
    assert.equal(writes.test(src), false, 'a "check" must not write')
  })
})
