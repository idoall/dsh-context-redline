/**
 * 我们的面板"现在真的可见吗"—— 决定那两条**改宿主元素**的 CSS 规则能不能生效
 * （`base.css` 里用 `[data-redline-active="1"]` 限定；Code Review P1-2）。
 *
 * 为什么不能只看"挂载了"：宿主今天"切走即卸载"，所以 `.redline-root` 存在≈我们的
 * tab 被选中；但若宿主改成"常驻只隐藏"，`.redline-root` 会在别的 tab（包括上游
 * 插件的 tab）里继续存在，那两条规则就会把**宿主的输入框/宽度拖柄**藏掉。
 * IntersectionObserver 给的是真实的可见性，正好对上这个判据。
 *
 * 退化：没有 `IntersectionObserver`（jsdom、老引擎）时按"挂载即活跃"处理 ——
 * 保住既有行为，不让功能因为缺一个观察器而消失。
 */

import { useEffect, type RefObject } from 'react'

/** 我们自己控制的标记属性；CSS 侧只认它。 */
export const REDLINE_ACTIVE_ATTR = 'data-redline-active'

/** 按元素真实可见性维护 `data-redline-active`（卸载时清掉）。 */
export function useSurfaceVisibility(ref: RefObject<Element | null>): void {
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const set = (on: boolean): void => {
      if (on) element.setAttribute(REDLINE_ACTIVE_ATTR, '1')
      else element.removeAttribute(REDLINE_ACTIVE_ATTR)
    }
    if (typeof IntersectionObserver === 'undefined') {
      set(true)
      return () => { set(false) }
    }
    const observer = new IntersectionObserver((entries) => {
      set(entries.some(entry => entry.isIntersecting))
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      set(false)
    }
  }, [ref])
}
