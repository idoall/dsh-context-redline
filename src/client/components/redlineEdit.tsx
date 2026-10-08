/**
 * The editing UI the demo fixes: a row's action bar, and the editor that expands
 * **under that row** (never a modal — the user is comparing against the context,
 * `docs/03` R3.1).
 *
 * The contract these two components keep, straight from `docs/03`'s current-demo
 * sections and `docs/11` D15/D16/D17/D19:
 *
 * · Row actions are **only** `编辑` (plus `丢弃这条改动` while a local edit exists).
 *   Host-protected rows render **no action area at all**; rows that cannot be
 *   rewritten render **one sentence** and no action (`R2.1`/`R2.3`).
 * · The marker `已改（本地）` appears **once**, beside the seq (`R4.1`, D20).
 * · Fields are keyed off the **durable type** `node.read` answered (`R3.2`): a tool
 *   result edits result-text + `isError`; everything else edits 正文 + a thinking
 *   text folded under 高级.
 * · The editor is prefilled with the FULL text — and, after a save, with the saved
 *   version (`effectiveText`), because that is the version in effect (D16).
 * · Saving writes only the plugin's local store, and the field carries the
 *   destination marker so nobody mistakes it for "the model can see this" (`R3.3`).
 * · `Esc` cancels, `Cmd/Ctrl+Enter` submits; a refusal keeps the input and shows
 *   the reason (`R3.5`).
 */

import { useEffect, useRef, useState, type ReactElement, type ChangeEvent, type KeyboardEvent } from 'react'
import type { ViewKit } from '../viewkit'
import { rowActions, type Ability } from '../../shared/redline-ability'

/** Why a row has no action — mapped to a sentence by the caller's dictionary. */
const REASON_KEY: Record<string, string> = {
  'assistant-immutable': 'redline.reason.assistant',
  'system-head': 'redline.reason.system',
  'shadowed': 'redline.reason.shadowed',
  'compacted': 'redline.reason.compacted',
}

/** The editor's submission. */
export interface RedlineSubmit {
  readonly text: string
  readonly reasoning: string
  readonly isError: boolean
}

/**
 * A row's action bar.
 *
 * @returns `null` for a host-protected row: the area is not rendered at all
 *   (an empty action strip would look like a missing feature, `docs/03` R2.1).
 */
export function makeRedlineActions(kit: ViewKit): (props: {
  seq: number
  ability: Ability
  hasLocalEdit: boolean
  /** 这一条是否已被标为「不要」（`docs/11` D65）。与 `hasLocalEdit` 互斥。 */
  excluded: boolean
  /** The advanced switch, only meaningful for `advancedOnly` rows (`R2.5`). */
  advanced: boolean
  busy: boolean
  onEdit: () => void
  onDrop: () => void
  /** 标为「不要」/ 取消标记。 */
  onExclude: () => void
  onUnexclude: () => void
  /**
   * 这一行**最近一次动作被拒**的稳定码（`redline/*`）。
   * ⚠️ 真机踩到：`标记为不要` 没有编辑器可依附，若只把错误丢给编辑器，拒绝就被吞掉了
   * （`docs/03` R3.5 要求"拒绝必须说出来"）。所以动作条自己也要能报。
   */
  errorCode: string | null
}) => ReactElement | null {
  const { t } = kit
  return function RedlineActions(props): ReactElement | null {
    const { ability } = props
    if (ability.inert) return null
    const actions = rowActions(ability, props.hasLocalEdit, props.excluded)
    const hiddenAsAdvanced = ability.advancedOnly && !props.advanced && (actions.includes('edit') || actions.includes('exclude'))
    /**
     * 改不了时的"为什么"徽章：助手消息要它（说明为什么没有「编辑」），
     * 但**已标为「不要」的行不要**（那时行上已经有「已标为不要」了，再来一句原因就是噪音）。
     */
    const reasonKey = REASON_KEY[ability.blockReason ?? ''] ?? 'redline.reason.other'
    const reasonChip = actions.includes('unexclude')
      ? null
      : <span className="redline-chip-soft" title={t(reasonKey)}>{t(reasonKey)}</span>
    return (
      <div className="redline-act" data-rowactions={props.seq}>
        <span className="redline-act-seq">{'#' + String(props.seq)}</span>
        {props.hasLocalEdit
          ? <span className="redline-chip-local" title={t('redline.local.tip')}>{t('redline.local')}</span>
          : null}
        {props.excluded
          ? <span className="redline-chip-excluded" title={t('redline.excluded.tip')}>{t('redline.excluded')}</span>
          : null}
        {hiddenAsAdvanced
          ? <span className="redline-chip-soft" title={t('redline.advanced.tip')}>{t('redline.advanced')}</span>
          : actions.includes('edit')
            ? <button type="button" className="redline-btn" disabled={props.busy} onClick={props.onEdit}>{t('redline.edit')}</button>
            : reasonChip}
        {actions.includes('exclude') && !hiddenAsAdvanced
          ? <button type="button" className="redline-btn redline-btn-quiet" title={t('redline.exclude.tip')} disabled={props.busy} onClick={props.onExclude}>{t('redline.exclude')}</button>
          : null}
        {actions.includes('unexclude') && !hiddenAsAdvanced
          ? <button type="button" className="redline-btn redline-btn-quiet" title={t('redline.unexclude.tip')} disabled={props.busy} onClick={props.onUnexclude}>{t('redline.unexclude')}</button>
          : null}
        {actions.includes('drop')
          ? <button type="button" className="redline-btn redline-btn-quiet" disabled={props.busy} onClick={props.onDrop}>{t('redline.drop')}</button>
          : null}
        {props.errorCode === null
          ? null
          : <span className="redline-act-err" role="alert">{t('redline.err.' + props.errorCode.replace('redline/', ''))}</span>}
      </div>
    )
  }
}

/**
 * The inline editor. Mounted by the row when it is the open editor, so its local
 * state lives exactly as long as the row is being edited.
 */
export function makeRedlineEditor(kit: ViewKit): (props: {
  seq: number
  /** The durable type `node.read` answered — this is what picks the fields. */
  type: string
  /** The version in effect (the original, or your saved edit). */
  initial: RedlineSubmit
  busy: boolean
  /**
   * Set when editing is not allowed at all right now: the demo's own gate
   * (`turnOpen || !live`) disables `保存` and shows the sentence, rather than
   * letting the click fail.
   */
  blocked: 'turn-open' | 'not-live' | null
  /** The stable refusal code to display, if the last attempt failed. */
  errorCode: string | null
  onSubmit: (edit: RedlineSubmit) => void
  onCancel: () => void
}) => ReactElement {
  const { t } = kit
  return function RedlineEditor(props): ReactElement {
    const [text, setText] = useState(props.initial.text)
    const [reasoning, setReasoning] = useState(props.initial.reasoning)
    const [isError, setIsError] = useState(props.initial.isError)
    const areaRef = useRef<HTMLTextAreaElement | null>(null)
    // A different row's values must never leak into this editor's state.
    useEffect(() => {
      setText(props.initial.text)
      setReasoning(props.initial.reasoning)
      setIsError(props.initial.isError)
    }, [props.seq])
    useEffect(() => { areaRef.current?.focus() }, [])

    const isToolResult = props.type === 'tool/result'
    const multiParagraph = props.initial.text.includes('\n')
    const submit = (): void => { props.onSubmit({ text, reasoning: isToolResult ? '' : reasoning, isError }) }
    const onKey = (ev: KeyboardEvent<HTMLDivElement>): void => {
      if (ev.key === 'Escape') { ev.preventDefault(); props.onCancel(); return }
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); submit() }
    }
    const errKey = props.errorCode === null ? null : `redline.err.${props.errorCode.replace('redline/', '')}`
    const blockedKey = props.blocked === 'turn-open'
      ? 'redline.blocked.turnOpen'
      : props.blocked === 'not-live' ? 'redline.blocked.notLive' : null

    return (
      <div className="redline-editor" onKeyDown={onKey}>
        {multiParagraph ? <div className="redline-editor-note">{t('redline.multiParagraph')}</div> : null}
        <label className="redline-editor-label" htmlFor={`redline-ed-${String(props.seq)}`}>
          {isToolResult ? t('redline.field.result') : t('redline.field.body')}
          <span className="redline-dest">{t('redline.dest.local')}</span>
        </label>
        <textarea
          id={`redline-ed-${String(props.seq)}`}
          ref={areaRef}
          className="redline-editor-text"
          value={text}
          rows={6}
          onChange={(ev: ChangeEvent<HTMLTextAreaElement>) => { setText(ev.target.value) }}
        />
        {isToolResult
          ? (
            <label className="redline-editor-check">
              <input type="checkbox" checked={isError} onChange={(ev: ChangeEvent<HTMLInputElement>) => { setIsError(ev.target.checked) }} />
              {t('redline.field.isError')}
              <span className="redline-dest">{t('redline.dest.local')}</span>
            </label>
          )
          : (
            <details className="redline-editor-adv">
              <summary>{t('redline.field.advanced')}</summary>
              <label className="redline-editor-label" htmlFor={`redline-edr-${String(props.seq)}`}>
                {t('redline.field.thinking')}
                <span className="redline-dest">{t('redline.dest.local')}</span>
              </label>
              <textarea
                id={`redline-edr-${String(props.seq)}`}
                className="redline-editor-text"
                value={reasoning}
                rows={3}
                onChange={(ev: ChangeEvent<HTMLTextAreaElement>) => { setReasoning(ev.target.value) }}
              />
            </details>
          )}
        {blockedKey !== null ? <div className="redline-editor-blocked">{t(blockedKey)}</div> : null}
        {errKey !== null ? <div className="redline-editor-err" role="alert">{t(errKey)}</div> : null}
        {/* 动作区**没有浮标**（用户 2026-10-06 红框截图：那个「?」压在「高级：思考文本」上）。
            它当初是给**批注**动作做说明的角标（`docs/10` M05-40），批注已整批删除；
            剩下的说明改挂按钮自身的 `title` —— 不占版面，鼠标停上去照样看得到。 */}
        <div className="redline-editor-actions">
          <button
            type="button"
            className="redline-btn"
            title={t('redline.save.tip')}
            disabled={props.busy || blockedKey !== null}
            onClick={submit}
          >{t('redline.save')}</button>
          <button type="button" className="redline-btn redline-btn-quiet" onClick={props.onCancel}>{t('redline.cancel')}</button>
        </div>
      </div>
    )
  }
}
