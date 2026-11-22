import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  HANDOFF_SKILL_CONTENT,
  HANDOFF_SKILL_NAME,
  handoffSkillRegistration,
  registerHandoffSkill,
} from '../../src/host/handoff-skill'

describe('context handoff skill (0.7.0)', () => {
  test('the registration is kebab-case and pins the four copy-paste blocks', () => {
    const skill = handoffSkillRegistration()
    assert.equal(skill.name, HANDOFF_SKILL_NAME)
    assert.equal(skill.source, 'runtime')
    assert.match(skill.name, /^[a-z][a-z0-9-]*$/)
    assert.ok(skill.description.length > 20)
    for (const label of ['首条任务', '目标', '验收标准', '执行纪律']) {
      assert.ok(skill.content.includes(label), `missing ${label}`)
    }
    for (const marker of ['情况 A', '情况 B', '每轮运行时规则', '最终发送全文']) {
      assert.ok(skill.content.includes(marker), `missing ${marker}`)
    }
    assert.ok(HANDOFF_SKILL_CONTENT.includes('每个里程碑结束必须停下汇报证据'))
    assert.ok(skill.content.length < 7000)
  })

  test('registers on the skills service through an injected fiber and never throws when absent', () => {
    const registered: unknown[] = []
    let disposed = false
    let dispose: (() => void) | undefined
    const fake = {
      inject(_deps: string[], callback: (c: unknown) => void) {
        callback({
          get(name: string) { return name === 'skills' ? { register(skill: unknown) { registered.push(skill); return () => { disposed = true } } } : undefined },
          effect(fn: () => () => void) { dispose = fn() },
        })
      },
    }
    registerHandoffSkill(fake as never)
    assert.equal(registered.length, 1)
    assert.equal((registered[0] as { name: string }).name, HANDOFF_SKILL_NAME)
    assert.equal(typeof dispose, 'function')
    dispose?.()
    assert.equal(disposed, true)

    assert.doesNotThrow(() => registerHandoffSkill({ inject(_deps: string[], callback: (c: unknown) => void) {
      callback({ get() { return undefined }, effect() {} })
    } } as never))
  })
})
