/**
 * The File Activity card — the user-benefit view of a step range: not what
 * the context is MADE of (messages) but what the agent DID with its tools
 * to the user's files. One row per touched file with per-purpose counts
 * (read/written/searched), an estimated line delta, and multimodal forms
 * (image reads, directory targets) flagged; the header chips double as
 * purpose/form filters and the search box narrows by path.
 *
 * Interaction mirrors the Context browser's element rows: a row click
 * expands the file's own operation log; each operation is itself the click
 * target that jumps to (and reveals) the exact tool result in the browser.
 * The file name opens the file's right-Sidebar preview where that column
 * exists (dsh 0.1.5-rc.1+, the shipped files-sidebar idiom), and the system
 * opener where it does not.
 */

import { memo, useState, type ChangeEvent, type ComponentType, type MouseEvent, type ReactElement } from 'react'
import { absPathOf, displayPathOf, glyphOf } from '../fileActivity'
import type { FileActivity, FileEntry, FileOp, FileOpKind } from '../fileActivity'
import type { ContextSettings, DefaultFileSort } from '../settings'
import type { DetailState } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeDetailNote } from './detailNote'

export type FileFilter = 'all' | FileOpKind | 'image'

export interface FileCardProps {
  activity: FileActivity
  /** The range label — the picked step, or the whole-session latest view. */
  scope: string
  /** The host workspace root: workspace paths display './'-relative when known. */
  workspace?: string
  /**
   * Open a file's right-Sidebar preview; returns whether the column took it, so
   * a refusal falls through to the system opener. Absent = this harness has no
   * preview column (the system-open path stays the only affordance).
   */
  onPreview?: (entry: FileEntry) => boolean
  /** Open a file on the user's system; absent = the file name renders inert. */
  onOpen?: (absPath: string) => void
  /** Reveal one operation's result node in the Context browser; absent = op lines render inert. */
  onLocate?: (op: FileOp) => void
  /**
   * The timeline source's detail state (split generation): the activity fold
   * reads the detail collections, so a pending/failed first read replaces the
   * empty claim with the pending note / retry button.
   */
  state?: DetailState
  onRetry?: () => void
}

export function makeFileCard(kit: ViewKit, settings: ContextSettings): ComponentType<FileCardProps> {
  const { t, fmt, fmtTime } = kit
  const DetailNote = makeDetailNote(kit)

  function matches(e: FileEntry, f: FileFilter): boolean {
    if (f === 'all') return true
    if (f === 'image') return e.form === 'image'
    if (f === 'read') return e.reads > 0
    if (f === 'write') return e.writes > 0
    return e.searches > 0
  }

  /** Signed line pair, harness diff semantics: growth on the success token, shrinkage on the error token. */
  function DeltaPair(props: { added: number; removed: number }): ReactElement {
    return (
      <span className="redline-fa-delta">
        {props.added > 0 ? <span className="redline-fa-up">{'+' + fmt(props.added)}</span> : null}
        {props.removed > 0 ? <span className="redline-fa-down">{'−' + fmt(props.removed)}</span> : null}
      </span>
    )
  }

  // Memoized at the factory level: the parent's activity/scope/onLocate props are all reference-stable across
  // hover/select renders (see contextView), so this card skips reconciliation whenever its own inputs did not move.
  return memo(function FileCard(props: FileCardProps): ReactElement {
    const { activity } = props
    const [filter, setFilter] = useState<FileFilter>('all')
    // Mount-time default from the plugin settings card; in-card toggling stays mount-local and never writes back.
    const [sort, setSort] = useState<DefaultFileSort>(() => settings.defaultFileSort())
    const [query, setQuery] = useState('')
    const [openPath, setOpenPath] = useState<string | null>(null)

    const q = query.trim().toLowerCase()
    // Display form of an entry's path: './'-relative inside the workspace, verbatim outside —
    // except pattern-as-target search rows, whose "path" is a search pattern, not a file.
    const displayOf = (e: FileEntry): string => (e.pattern === true ? e.path : displayPathOf(e.path, props.workspace))
    // The count sort's magnitude: the selected kind's own ops when a kind
    // chip is active (a file heavy on writes must not outrank one heavy on
    // reads under the read chip), else the file's overall op count.
    const countOf = (e: FileEntry): number =>
      filter === 'read' ? e.reads : filter === 'write' ? e.writes : filter === 'search' ? e.searches : e.ops.length
    /* The fold serves entries latest-first; the sort toggle re-orders the filtered copy (never the source array). */
    const shown = activity.entries
      .filter(e => matches(e, filter) && (q === '' || displayOf(e).toLowerCase().includes(q)))
      .sort((a, b) => sort === 'count'
        ? (countOf(b) - countOf(a)) || (b.ops[0].seq - a.ops[0].seq)
        : sort === 'latest'
          ? b.ops[0].seq - a.ops[0].seq
          // Paths are unique map keys: a two-way comparison orders them fully.
          : (a.path < b.path ? -1 : 1))

    const chips: { key: FileFilter; files: number; ops: number }[] = [
      {
        key: 'all',
        files: activity.entries.length,
        ops: activity.totals.read.ops + activity.totals.write.ops + activity.totals.search.ops,
      },
      { key: 'read', files: activity.totals.read.files, ops: activity.totals.read.ops },
      { key: 'write', files: activity.totals.write.files, ops: activity.totals.write.ops },
      { key: 'search', files: activity.totals.search.files, ops: activity.totals.search.ops },
      { key: 'image', files: activity.totals.image.files, ops: activity.totals.image.ops },
    ]

    const opLine = (op: FileOp): ReactElement => (
      <>
        <span className="redline-fa-op-tool" title={op.tool}>{op.tool}</span>
        {/* A read's line footprint: the exact `>>n` window off the result meta, or the ≈ limit estimate. */}
        {op.read !== undefined
          ? (
            <span
              className="redline-fa-read"
              title={'est' in op.read
                ? t('files.readEst')
                : t('files.readTip', { a: fmt(op.read.start), b: fmt(op.read.start + op.read.count - 1) })}
            >
              {('est' in op.read ? '≈' : '>>') + fmt(op.read.count)}
            </span>
          )
          : null}
        {op.detail !== undefined ? <span className="redline-fa-op-detail">{op.detail}</span> : null}
        {op.hits !== undefined ? <span className="redline-fa-op-detail">{t('files.hits', { n: fmt(op.hits) })}</span> : null}
        {/* A nested PTC op with nothing else to say still tells why: its program's description. */}
        {op.detail === undefined && op.hits === undefined && op.program !== undefined
          ? <span className="redline-fa-op-detail">{op.program}</span>
          : null}
        {op.added + op.removed > 0 ? <DeltaPair added={op.added} removed={op.removed} /> : null}
        {op.err ? <span className="redline-br-err-dot" title={t('node.failed')} /> : null}
        {/* The time rides the right edge, mirroring the file row above. */}
        <span className="redline-fa-op-time">{op.time !== undefined ? fmtTime(op.time) : '—'}</span>
      </>
    )

    return (
      <div className="redline-card redline-col flex-1 min-w-[min(360px,100%)]">
        <div className="redline-card-title">
          <span className="redline-card-title-text">{t('files.title')}</span>
          <span className="redline-card-sub">{props.scope}</span>
        </div>
        {activity.entries.length === 0 && props.state === 'loading' ? (
          <DetailNote state="loading" />
        ) : activity.entries.length === 0 && props.state === 'failed' && props.onRetry !== undefined ? (
          <DetailNote state="failed" onRetry={props.onRetry} />
        ) : activity.entries.length === 0 ? (
          <div className="redline-empty">{t('files.empty')}</div>
        ) : (
          <div>
            <div className="redline-fa-ctl">
              {/* The five purpose chips (labels + counts) overflow a ~300px card in English — flow the group to two lines. */}
              <div className="redline-gran @max-[380px]/redline-card:flex-wrap">
                {chips.map(c => (
                  <button
                    key={c.key}
                    type="button"
                    // Kind chips carry their badge color (the row pills below) in every state.
                    className={'redline-gran-btn' + (filter === c.key ? ' redline-gran-on' : '')
                      + (c.key === 'read' || c.key === 'write' || c.key === 'search' ? ' redline-fa-chip-' + c.key : '')}
                    title={t('files.chipTip', { files: c.files, ops: c.ops })}
                    onClick={() => { setFilter(cur => (cur === c.key ? 'all' : c.key)) }}
                  >
                    {t('files.kind.' + c.key)}
                    <b className="redline-fa-n">{fmt(c.ops)}</b>
                  </button>
                ))}
              </div>
              <input
                className="redline-fa-search focus:border-(--dsw-alias-label-dimmed)"
                value={query}
                placeholder={t('files.search')}
                onChange={(ev: ChangeEvent<HTMLInputElement>) => { setQuery(ev.target.value) }}
              />
            </div>
            <div className="redline-fa-meta">
              <span>{t('files.files', { n: activity.entries.length })}</span>
              {activity.totals.added + activity.totals.removed > 0 ? (
                /* The one styled tip of the card: it lives OUTSIDE the scrolling list, so the bubble never clips. */
                <span className="redline-fa-meta-delta group/tip">
                  <DeltaPair added={activity.totals.added} removed={activity.totals.removed} />
                  <span className="redline-tip redline-fa-meta-tip group-hover/tip:opacity-100" role="tooltip">{t('files.deltaTip')}</span>
                </span>
              ) : null}
              <span className="redline-gran redline-fa-sort" role="group" title={t('files.sortTip')}>
                {(['count', 'latest', 'path'] as const).map(k => (
                  <button
                    key={k}
                    type="button"
                    className={'redline-gran-btn' + (sort === k ? ' redline-gran-on' : '')}
                    onClick={() => { setSort(k) }}
                  >
                    {t('files.sort.' + k)}
                  </button>
                ))}
              </span>
            </div>
            {shown.length === 0 ? (
              <div className="redline-empty">{t('files.noMatch')}</div>
            ) : (
              <div className="redline-fa-list">
                {shown.map((e) => {
                  const open = openPath === e.path
                  // The path column renders the display form; the row title keeps the raw path.
                  const display = displayOf(e)
                  const trimmed = display.endsWith('/') ? display.slice(0, -1) : display
                  const slash = trimmed.lastIndexOf('/')
                  const dir = slash >= 0 ? trimmed.slice(0, slash + 1) : ''
                  const base = slash >= 0 ? trimmed.slice(slash + 1) : trimmed
                  const glyph = glyphOf(e.path, e.form)
                  // The system-open affordance: real paths resolve to absolute; pattern rows are not files.
                  const abs = e.pattern === true ? undefined : absPathOf(e.path, props.workspace)
                  // The preview affordance leads where the column exists: a real
                  // file (never a search pattern or directory target) opens its
                  // Sidebar tab, and a refusal falls through to the system opener.
                  const previewable = props.onPreview !== undefined && e.pattern !== true && e.form !== 'dir'
                  const openable = previewable || (abs !== undefined && props.onOpen !== undefined)
                  return (
                    <div key={e.path} className={'redline-fa-item' + (open ? ' redline-fa-item-on' : '')}>
                      <button
                        type="button"
                        className="redline-fa-row hover:bg-(--dsw-alias-interactive-bg-hover) @max-[380px]/redline-card:flex-wrap"
                        title={e.path}
                        onClick={() => { setOpenPath(open ? null : e.path) }}
                      >
                        <span className={'redline-br-chev' + (open ? ' redline-br-chev-on' : '')} />
                        <span className="redline-fa-form" title={t(glyph.tip)}>
                          {glyph.color !== undefined
                            ? (
                              <span className="redline-fa-lang" style={{ background: glyph.color, color: glyph.text }}>
                                {glyph.glyph}
                              </span>
                            )
                            : glyph.glyph}
                        </span>
                        {/* Narrow cards: wrap instead of crushing — the path's near-full-width basis keeps
                            line 1 to chevron + icon + path, badges/delta/time fold onto line 2. The 46px
                            reservation is chevron (12) + gaps (2×7) + form icon (20). */}
                        <span className="redline-fa-path flex-1 @max-[380px]/redline-card:basis-[calc(100%-46px)]">
                          {dir !== '' ? <em>{dir}</em> : null}
                          {openable
                            ? (
                              <b
                                className="redline-fa-file hover:underline"
                                title={t(previewable ? 'files.preview' : 'files.open')}
                                onClick={(ev: MouseEvent) => {
                                  ev.stopPropagation()
                                  if (previewable && props.onPreview?.(e) === true) return
                                  if (abs !== undefined) props.onOpen?.(abs)
                                }}
                              >
                                {base}
                              </b>
                            )
                            : <b>{base}</b>}
                        </span>
                        {e.reads > 0 ? (
                          <span className="redline-fa-badge redline-fa-b-read" title={t('files.kind.read')}><i />{fmt(e.reads)}</span>
                        ) : null}
                        {e.writes > 0 ? (
                          <span className="redline-fa-badge redline-fa-b-write" title={t('files.kind.write')}><i />{fmt(e.writes)}</span>
                        ) : null}
                        {e.searches > 0 ? (
                          <span className="redline-fa-badge redline-fa-b-search" title={t('files.kind.search')}><i />{fmt(e.searches)}</span>
                        ) : null}
                        {e.added + e.removed > 0 ? <DeltaPair added={e.added} removed={e.removed} /> : null}
                        {e.errs > 0 ? <span className="redline-br-err-dot" title={t('files.errs', { n: e.errs })} /> : null}
                        {e.ops[0].time !== undefined
                          ? <span className="redline-fa-time">{fmtTime(e.ops[0].time)}</span>
                          : null}
                      </button>
                      {open ? (
                        <div className="redline-fa-ops">
                          {e.ops.map((op, i) => {
                            const onLocate = props.onLocate
                            // A meta-attributed search rows one op per matched file off ONE
                            // result — the ops share that result's seq, so the key joins the index.
                            const key = `${op.seq}:${i}`
                            return onLocate !== undefined
                              ? (
                                <button
                                  key={key}
                                  type="button"
                                  className="redline-fa-op redline-fa-op-link hover:bg-(--dsw-alias-interactive-bg-hover)"
                                  title={t('files.locate')}
                                  onClick={() => { onLocate(op) }}
                                >
                                  {opLine(op)}
                                </button>
                              )
                              : <div key={key} className="redline-fa-op">{opLine(op)}</div>
                          })}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    )
  })
}
