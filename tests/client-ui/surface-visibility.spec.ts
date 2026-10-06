// 「我们的面板真的可见吗」这个判据（Code Review P1-2）。
//
// 为什么它值得一条门禁：`base.css` 里有两条规则会去改**宿主**的元素（输入区、宽度拖柄）。
// 它们若只按"挂载了"生效，宿主一旦改成"常驻只隐藏"，就会在**别的 tab**（包括上游插件的）
// 上把宿主输入框藏掉。这条测试钉住三件事：
//   ① 观察器说"可见" → 挂标记；② 说"不可见" → 去掉标记；③ 卸载 → 一定清掉；
//   ④ 没有 IntersectionObserver 的环境（jsdom/老引擎）→ 退回"挂载即活跃"，功能不消失。

import { act, createElement as h, useRef } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { REDLINE_ACTIVE_ATTR, useSurfaceVisibility } from '../../src/client/surfaceVisibility'
import { mount, type Mounted } from '../client/helpers/kit'

/** 一个最小宿主：把 hook 挂在它自己的 div 上。 */
function Panel(): ReturnType<typeof h> {
  const ref = useRef<HTMLDivElement | null>(null)
  useSurfaceVisibility(ref)
  return h('div', { className: 'redline-root', ref })
}

interface Stubbed {
  fire: (isIntersecting: boolean) => void
  observed: number
  disconnected: number
}

/** 装一个可手动触发的 IntersectionObserver 替身。 */
function stubObserver(): Stubbed {
  const state: Stubbed = { fire: () => {}, observed: 0, disconnected: 0 }
  const callbacks: ((entries: { isIntersecting: boolean }[]) => void)[] = []
  class Fake {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) { callbacks.push(cb) }
    observe(): void { state.observed += 1 }
    disconnect(): void { state.disconnected += 1 }
  }
  ;(globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = Fake
  state.fire = (isIntersecting: boolean) => { for (const cb of callbacks) act(() => { cb([{ isIntersecting }]) }) }
  return state
}

let mounted: Mounted | null = null
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
})

describe('the visibility marker that gates our host-affecting CSS', () => {
  test('visible → marker on; hidden → marker off', async () => {
    const io = stubObserver()
    mounted = await mount(h(Panel))
    const root = mounted.container.querySelector('.redline-root')
    assert.ok(root !== null, '面板渲染出来了')
    assert.equal(io.observed, 1, '观察了我们的根元素')
    assert.equal(root!.getAttribute(REDLINE_ACTIVE_ATTR), null, '还没报可见 ⟹ 不挂标记')
    io.fire(true)
    assert.equal(root!.getAttribute(REDLINE_ACTIVE_ATTR), '1', '可见 ⟹ 挂标记')
    io.fire(false)
    assert.equal(root!.getAttribute(REDLINE_ACTIVE_ATTR), null, '不可见 ⟹ 去掉标记（这就是防误伤别人 tab 的那一步）')
  })

  test('unmounting always clears the marker', async () => {
    const io = stubObserver()
    mounted = await mount(h(Panel))
    const root = mounted.container.querySelector('.redline-root')
    io.fire(true)
    assert.equal(root!.getAttribute(REDLINE_ACTIVE_ATTR), '1')
    if (mounted !== null) await mounted.unmount()
    mounted = null
    assert.equal(io.disconnected, 1, '观察器被断开')
    assert.equal(root!.getAttribute(REDLINE_ACTIVE_ATTR), null, '卸载后标记必须清掉')
  })

  test('no IntersectionObserver (old engines) → falls back to "mounted = active"', async () => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver
    mounted = await mount(h(Panel))
    const root = mounted.container.querySelector('.redline-root')
    assert.equal(root!.getAttribute(REDLINE_ACTIVE_ATTR), '1', '没有观察器时不能失去功能')
  })
})
