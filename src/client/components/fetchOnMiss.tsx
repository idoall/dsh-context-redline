/**
 * The fetch-on-miss state machine behind the Context browser's on-demand
 * reads (a row's full message content, a header epoch's tool schemas, and the
 * list of surviving system messages that make up the prompt in force): one
 * targeted history read per key the local data missed, with a visible
 * terminal state for every outcome — `absent` when the durable log does not
 * hold the key, `failed` arming the retry button, never an unhandled
 * rejection or a spinner that never resolves. Landed values cache by key:
 * history is immutable, so a resolved key never refetches.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Translate } from '../i18n'

export type FetchMissState = 'idle' | 'loading' | 'absent' | 'failed'

export interface FetchOnMiss<T> {
  /** Resolved values by key (immutable history — a landed value never refetches). */
  values: Map<number, T>
  state: FetchMissState
  /** Re-arm the read after a failure (the retry button). */
  retry: () => void
}

/**
 * Run one fetch for `key` when it is set and not yet cached. `key` null (no
 * target open) or `fetcher` undefined (older host without the history face)
 * leaves the machine idle; the caller renders the matching note either way.
 */
export function useFetchOnMiss<T>(
  key: number | null,
  fetcher: ((key: number) => Promise<T | null>) | undefined,
  warn: string,
): FetchOnMiss<T> {
  const keys = useMemo<readonly number[]>(() => (key === null ? [] : [key]), [key])
  return useFetchMany(keys, fetcher, warn)
}

/**
 * The same machine over a LIST of keys — the system prompt in force is every
 * surviving `system/message` (head plus section updates), so its text needs
 * one read per node. Each key behaves exactly like the single-key read: a
 * landed value caches, a null answer marks the batch `absent`, a rejection
 * marks it `failed` and arms one retry for every still-missing key.
 */
export function useFetchMany<T>(
  keys: readonly number[],
  fetcher: ((key: number) => Promise<T | null>) | undefined,
  warn: string,
): FetchOnMiss<T> {
  const [values, setValues] = useState<Map<number, T>>(() => new Map())
  const [state, setState] = useState<FetchMissState>('idle')
  const [attempt, setAttempt] = useState(0)
  // The list identity changes every render (map over the wire nodes); the
  // joined seqs are the stable dependency the machine reacts to.
  const keyList = keys.join(',')
  useEffect(() => {
    if (fetcher === undefined || keyList === '') return
    const missing = keyList.split(',').map(Number).filter(key => !values.has(key))
    if (missing.length === 0) return
    let live = true
    setState('loading')
    void Promise.all(missing.map(async (key): Promise<{ key: number; value: T | null; failed: boolean }> => {
      try {
        return { key, value: await fetcher(key), failed: false }
      } catch (error) {
        console.warn(warn, error)
        return { key, value: null, failed: true }
      }
    })).then((landed) => {
      if (!live) return
      const failed = landed.some(entry => entry.failed)
      const absent = landed.some(entry => !entry.failed && entry.value === null)
      // Land only real values: re-creating the map on an absent/failed batch
      // would change the `values` dependency and refetch on the next render —
      // an absent read must settle, and a failure must wait for the retry.
      const values_ = landed.filter(entry => entry.value !== null)
      if (values_.length > 0) {
        setValues((prev) => {
          const next = new Map(prev)
          for (const entry of values_) next.set(entry.key, entry.value as T)
          return next
        })
      }
      setState(failed ? 'failed' : absent ? 'absent' : 'idle')
    })
    return () => { live = false }
  }, [keyList, fetcher, attempt, values, warn])
  return { values, state, retry: () => { setAttempt(a => a + 1) } }
}

/**
 * The note a not-yet-loaded fetch target shows — one expression for both
 * on-demand reads: the legacy static hint (`emptyKey`) when no fetcher is
 * composed, `loading` while the read is in flight (and on the first frame
 * before the effect fires), `notInLog` when the durable log does not hold
 * the key, and a retry button after a failed read.
 */
export function fetchMissNote(
  t: Translate,
  fetcher: unknown,
  state: FetchMissState,
  onRetry: () => void,
  emptyKey: 'browser.noContent' | 'browser.headerMetaOnly',
): ReactNode {
  if (fetcher === undefined) return t(emptyKey)
  if (state === 'absent') return t('browser.notInLog')
  if (state === 'failed') {
    return (
      <button type="button" className="redline-br-retry hover:brightness-[1.15]" onClick={onRetry}>
        {t('browser.loadFailed')}
      </button>
    )
  }
  return t('browser.loading')
}
