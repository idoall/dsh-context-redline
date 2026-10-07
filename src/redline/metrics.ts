/**
 * 「这段字有多大」—— `docs/10` **M2-20** 的口径层。
 *
 * 消费者是**开子会话确认框**（`docs/10` M2-20 的原话："首条任务会有多少字节"）：
 * 那句话是新会话的第一句话，也是本地改动**唯一的出口**（`docs/11` D15）⟹
 * 人在点「确认」之前就该看得到它有多大、里面带了几条改动。
 *
 * 三条口径（都有单测钉住）：
 *  ① 字节一律按 **UTF-8** 算（中文一字 3 字节、emoji 4 字节）——**不是**字符数，也不用 `Buffer`
 *     （`src/redline/**` 是纯逻辑，禁 `node:*` ⟹ 这里手写一遍码点宽度）；
 *  ② 行数 = 按 `\n` 切的行数，**末尾那个换行不算新行**（空串 = 0 行）；
 *  ③ **一个字符都不许被"顺手整理"**：算的就是将要发出去的那段字本身（不去空白、不做规范化）。
 */

/** UTF-8 字节数（按码点算宽度：<0x80 → 1；<0x800 → 2；<0x10000 → 3；其余 4）。 */
export function utf8BytesOf(text: string): number {
  let bytes = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** 首条任务的读数：多大（UTF-8 字节）、几行、带了几条本地改动。 */
export interface FirstTaskMetrics {
  readonly bytes: number
  readonly lines: number
  readonly edits: number
}

/**
 * @param prompt - **将要成为新会话第一句话的那段字**（就是 `buildFirstTask()` 的产物本身）。
 * @param editCount - 里面逐字带了几条本地改动。
 */
export function firstTaskMetricsOf(prompt: string, editCount: number): FirstTaskMetrics {
  const trimmedTail = prompt.endsWith('\n') ? prompt.slice(0, -1) : prompt
  return {
    bytes: utf8BytesOf(prompt),
    lines: prompt === '' ? 0 : trimmedTail.split('\n').length,
    edits: editCount,
  }
}
