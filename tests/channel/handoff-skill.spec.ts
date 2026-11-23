import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  HANDOFF_SKILL_CONTENT,
  HANDOFF_SKILL_NAME,
  handoffSkillRegistration,
  registerHandoffSkill,
} from '../../src/host/handoff-skill'

describe('context handoff skill (0.9.4)', () => {
  test('the registration is kebab-case and pins the four copy-paste blocks', () => {
    const skill = handoffSkillRegistration()
    assert.equal(skill.name, HANDOFF_SKILL_NAME)
    assert.equal(skill.source, 'runtime')
    assert.match(skill.name, /^[a-z][a-z0-9-]*$/)
    assert.ok(skill.description.length > 20)
    for (const label of ['首条任务', '目标', '验收标准', '执行纪律']) {
      assert.ok(skill.content.includes(label), `missing ${label}`)
    }
    for (const marker of ['情况 A', '情况 B', '每轮运行时规则', '最终发送全文', '有头 UAT', '主会话不直接开发', '子会话或团队成员', '先拆任务', '不得把所有工作合成一个连续任务', '不得自己连续做多个任务', '即使我说“过程中不用确认”', '任务清单', 'T1 |', '目标守卫（可选 · 要勾选就先贴这一段）', '离开这段对话也能判', '不要编造 provider/model 名称', '0.9.0 只观察', '计划文件', '直接继续下一个', '不逐任务等用户批准', '用户逐任务批准', '这四种情况']) {
      assert.ok(skill.content.includes(marker), `missing ${marker}`)
    }
    assert.ok(HANDOFF_SKILL_CONTENT.includes('主会话对照验收审查通过一个任务后**直接继续下一个**'))
    assert.match(skill.description, /Goal Guard/)
    assert.ok(!skill.content.includes('只在用户要启用'), 'the guard block is always offered, the user decides')
    assert.ok(skill.content.includes('让用户自己决定要不要勾选'))
    assert.ok(!skill.content.includes('用户明确“通过”后才进入下一个'), 'no per-task user approval gate')
    assert.match(skill.whenToUse, /Goal Guard/)
    assert.ok(skill.content.includes('判不了就改成命令 / 文件 / 可观察结果'))
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
