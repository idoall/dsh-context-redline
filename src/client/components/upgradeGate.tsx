/**
 * The baseline-gate modal: when the host reports the running harness below
 * the supported baseline (the `unsupported` record on the pushed
 * `redlineTimeline` value — see host/fallback.ts), the Context tab keeps
 * rendering its (zeroed) cards and this centered dialog names the detected
 * harness version against the required minimum and urges the upgrade.
 *
 * Dismissal is remembered per session in a module-level ledger: tab remounts
 * do not re-pop it, while a fresh app launch does — the gate stays visible
 * until the harness is actually updated.
 */

import { useCallback, useState, type ReactElement } from 'react'
import type { ViewKit } from '../viewkit'
import { useEscapeClose } from './escapeClose'

/** Sessions whose gate the user already dismissed this browser session. */
const dismissed = new Set<string>()

export interface UpgradeGateProps {
  sessionId?: string
  /** The detected harness version (displayed verbatim, already re-proved). */
  current: string
  /** The plugin's minimum supported baseline. */
  minimum: string
}

export function makeUpgradeGate(kit: ViewKit): (props: UpgradeGateProps) => ReactElement | null {
  const { t } = kit
  return function UpgradeGate(props: UpgradeGateProps): ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    // `closedFor` re-renders on dismiss within one mount; the ledger covers
    // remounts and in-place session switches.
    const [closedFor, setClosedFor] = useState<string | null>(null)
    const closed = closedFor === sessionId || dismissed.has(sessionId)
    const close = useCallback(() => {
      dismissed.add(sessionId)
      setClosedFor(sessionId)
    }, [sessionId])

    // Same overlay contract as the /redline modal (escapeClose.ts):
    // capture-phase Escape, and focus returns to the pre-open element.
    useEscapeClose(!closed, close)

    if (closed) return null

    return (
      <div className="redline-modal-backdrop" onClick={close}>
        <div className="redline-modal-card redline-gate-card" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="redline-modal-head">
            <span className="redline-modal-title">{t('gate.title')}</span>
            <button className="redline-modal-close hover:text-(--dsw-alias-label-primary) hover:bg-(--dsw-alias-bg-layer-2)" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>
          <div className="redline-gate-body">{t('gate.body', { minimum: props.minimum })}</div>
          <div className="redline-gate-versions">
            <span className="redline-gate-version">
              <span className="redline-gate-version-label">{t('gate.current')}</span>
              <span className="redline-gate-version-value">v{props.current}</span>
            </span>
            <span className="redline-gate-version">
              <span className="redline-gate-version-label">{t('gate.minimum')}</span>
              <span className="redline-gate-version-value">
                v{props.minimum}
                <span className="redline-gate-or-newer">{t('gate.orNewer')}</span>
              </span>
            </span>
          </div>
          <div className="redline-gate-actions">
            <button type="button" className="redline-gate-ok hover:brightness-110" onClick={close}>{t('gate.ok')}</button>
          </div>
        </div>
      </div>
    )
  }
}
