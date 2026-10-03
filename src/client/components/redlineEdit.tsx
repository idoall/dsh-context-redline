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
  /** The advanced switch, only meaningful for `advancedOnly` rows (`R2.5`). */
  advanced: boolean
  busy: boolean
  onEdit: () => void
  onDrop: () => void
}) => ReactElement | null {
  const { t } = kit
  return function RedlineActions(props): ReactElement | null {
    const { ability } = props
    if (ability.inert) return null
    const actions = rowActions(ability, props.hasLocalEdit)
    const hiddenAsAdvanced = ability.advancedOnly && !props.advanced && actions.includes('edit')
    return (
      <div className="redline-act" data-rowactions={props.seq}>
        <span className="redline-act-seq">{'#' + String(props.seq)}</span>
        {props.hasLocalEdit
          ? <span className="redline-chip-local" title={t('redline.local.tip')}>{t('redline.local')}</span>
          : null}
        {hiddenAsAdvanced
          ? <span className="redline-chip-soft" title={t('redline.advanced.tip')}>{t('redline.advanced')}</span>
          : actions.includes('edit')
            ? <button type="button" className="redline-btn" disabled={props.busy} onClick={props.onEdit}>{t('redline.edit')}</button>
            : <span className="redline-chip-soft" title={t(REASON_KEY[ability.blockReason ?? ''] ?? 'redline.reason.other')}>{t(REASON_KEY[ability.blockReason ?? ''] ?? 'redline.reason.other')}</span>}
        {actions.includes('drop')
          ? <button type="button" className="redline-btn redline-btn-quiet" disabled={props.busy} onClick={props.onDrop}>{t('redline.drop')}</button>
          : null}
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
        {errKey !== null ? <div className="redline-editor-err" role="alert">{t(errKey)}</div> : null}
        <div className="redline-editor-actions">
          <span className="redline-qwrap">
            <button
              type="button"
              className="redline-btn"
              disabled={props.busy}
              onClick={submit}
            >{t('redline.save')}</button>
            <span className="redline-qfloat" title={t('redline.save.tip')} aria-label={t('redline.save.tip')}>?</span>
          </span>
          <button type="button" className="redline-btn redline-btn-quiet" onClick={props.onCancel}>{t('redline.cancel')}</button>
        </div>
      </div>
    )
  }
}
