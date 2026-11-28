/**
 * Context tab root: renders the `redlineTimeline` projection and composes stats, composition, history, events and messages.
 * The data plane is the harness's projection pipeline end to end; the one addition is the split generation's on-demand
 * detail read (timelineSource.ts) — the pushed wire value is the slim head, and the heavy collections arrive from the
 * host's detail endpoint only while the tab (or modal) is open.
 */

import { createElement as h, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement } from 'react'
import type { ContextEventRecord, RequestRecord, SurfaceNode } from '../../shared/types'
import { briefNodes, briefOf } from '../brief'
import type { ContextViewProps } from '../services'
import { conversationNodesOf, headersOf, imageLoaderOf, openSessionVia, projectionOf, unsupportedOf } from '../services'
import type { ClientCtx, ConversationNodeLike } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useTimelineSource } from '../timelineSource'
import { makeDetailNote } from './detailNote'
import type { ContextSettings } from '../settings'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { useRedlineDrafts } from '../redlineDrafts'
import { readCarrierModels, readSupervisor, resumeSupervisor, rollbackSupervisor, switchSupervisor } from '../redlineChannel'
import type { SupervisorSummary } from '../../shared/redline-supervisor'
import { useChildSessions } from '../childSessions'
import { makeChildCard } from './childCard'
import { makeEventList } from './events'
import { makeUpgradeGate } from './upgradeGate'
import { makeRequestDetail } from './requestDetail'
import { countsOfRecords, makeStatsContext } from './statsContext'
import { assemble, stepStatsOf } from '../assemble'
import { makeStackedBar } from './stackedBar'
import { aggregateByTurn, attachMarkers, jumpTargetOf, makeTrendChart, turnStepsOf } from './trendChart'
import { modeAfterDnaChange, trendBandsOf } from '../dna'

import { subscribeContextFocus, takeContextFocus } from '../viewFocus'
import { useSurfaceVisibility } from '../surfaceVisibility'
import { revealInScrollParent } from '../revealScroll'
import { makeErrorBoundary } from './errorBoundary'

// The context page scrolls inside the conversation's shared `[data-conversation-scroll]` container, which the chat bottom-anchors — mirror
// the chat's chatScroll pattern: a module-level per-session position ledger (survives tab remounts), restored once content renders; first
// visits start at the top.
const viewScroll = new Map<string, number>()

const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const

export function makeContextView(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
): (props: ContextViewProps) => ReactElement {
  const { t } = kit
  const StackedBar = makeStackedBar(kit)
  const TrendChart = makeTrendChart(kit)
  const RequestDetail = makeRequestDetail(kit, StackedBar)
  const EventList = makeEventList(kit)
  // One page-scope cold-head cache serves both subagent-data readers: the
  const StatsContext = makeStatsContext(kit)
  const UpgradeGate = makeUpgradeGate(kit)
  const DetailNote = makeDetailNote(kit)
  const ContextBrowser = makeContextBrowser(kit, StackedBar, settings)
  const ErrorBoundary = makeErrorBoundary(t)

  // The body renders under the error boundary: a corrupt projection value (past the timelineOf shape guard) degrades to a styled error
  // card, not a white screen; the boundary itself has NO hooks, so the body's hook order and loading/data flow stay unchanged.
  function ContextViewBody(props: ContextViewProps): ReactElement {
    const sessionId = props.sessionId
    // The right Sidebar's panel is a narrow column: it drops the two head cards
    // that only pay off on the full-width tab (context stats, plugin info).
    const inSidebar = props.host === 'sidebar'
    // The timeline source (timelineSource.ts): the pushed value on the inline
    // generation, or the slim head merged with the on-demand detail on the
    // split generation. `detailState`/`retryDetail` drive the detail cards'
    // loading/failed notes.
    const source = useTimelineSource(ctx, props)
    const data = source.data
    // Official token-meter `contextPressure` projection — the same key the chat's context ring reads; token-meter owns estimation, the Host
    // no longer mirrors it. Absent → derived fallback.
    // Official token-meter `contextBreakdown` projection — the exact rows the chat ring's click-open panel shows, so the overview legend
    // reads identically by construction; absent → the fold's own same-estimator sums inside headlineOf.
    // Legacy fork rows remain readable from the platform catalog; ordinary carrier rows come from `carrier.list`.
    const childCatalog = projectionOf(props, 'subagentCatalog', raw => (Array.isArray(raw) ? raw : null))
    // `redlineHeaders` companion projection (full system prompt + tool schemas) for the Context browser; absent key = older Host half →
    // those sections degrade to tokens-only with a note.
    const headers = projectionOf(props, 'redlineHeaders', headersOf)
    const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = useState<number | null>(null)
    // Mount-time default from the plugin settings card; in-chart toggling stays mount-local and never writes back.
    const [granularity, setGranularity] = useState<'step' | 'turn'>(() => settings.defaultGranularity())
    // 'total' plots each request's cumulative composition, 'delta' its incremental change vs the previous one;
    // like granularity, the default is read at mount and in-chart toggling never writes back.
    const [trendMode, setTrendMode] = useState<'total' | 'delta'>(() => settings.defaultTrendMode())
    // Adaptive scale (the title-adjacent toggle): the trend bars rescale to the visible window; like the two
    // toggles above, mount-local and never written back.
    const [adaptive, setAdaptive] = useState(false)
    const [durationCurve, setDurationCurve] = useState(true)
    // DNA mode is shared by the trend bars and the browser's composition strip:
    // one switch, both cards move. It forces total semantics (the bands are the
    // composition), so turning it on parks the Total/Delta switch at total.
    const [dna, setDna] = useState(false)
    const [supervisor, setSupervisor] = useState<SupervisorSummary | null>(null)
    const [supervisorBusy, setSupervisorBusy] = useState(false)
    // Only needed when a blocked run has no configured fallback: the ledger still
    // accepts an explicit route, so the card can offer one.
    const [switchModels, setSwitchModels] = useState<{
      readonly provider: string
      readonly model: string
      readonly label: string
      readonly efforts: readonly { readonly id: string; readonly name: string }[]
    }[]>([])
    const [switchTarget, setSwitchTarget] = useState('')
    // The chosen route's reasoning level; empty means "the adapter's default".
    // It resets whenever the model or the session changes.
    const [switchEffort, setSwitchEffort] = useState('')
    const [rollbackArmed, setRollbackArmed] = useState(false)
    // Which action failed, so the card never labels a failed "continue" as a
    // failed rollback.
    const [supervisorError, setSupervisorError] = useState<{
      readonly action: 'rollback' | 'resume' | 'switch'
      readonly message: string
    } | null>(null)
    // `goalResumed:false` is an ACTION result, not a durable ledger fact, so it
    // lives beside the polled summary: the 3-second poll replaces `supervisor`
    // with the disk snapshot, which must not erase the warning. It is cleared by
    // a session switch, by the next action, or once a poll shows the run
    // finished (or moved on), which makes the old warning stale.
    const [goalResumeHint, setGoalResumeHint] = useState(false)
    // A switch whose resume half was refused: the model DID change, so this is
    // shown as its own notice instead of a "model switch failed" error.
    const [resumeRefused, setResumeRefused] = useState<string | null>(null)
    /** Bumped on every session change so a late rollback reply is dropped. */
    const rollbackGeneration = useRef(0)
    /**
     * Bumped when an action is dispatched and again when its answer is applied.
     * A poll that started before either carries an older generation: its answer
     * describes a ledger the card no longer shows, so it is dropped instead of
     * overwriting the action result and clearing its warning.
     */
    const supervisorPollGen = useRef(0)
    /**
     * Last observed run progress. The goal-resume warning and the resume
     * refusal are ACTION results, not ledger facts; a poll that shows the run
     * completed (or further along) proves them stale.
     */
    const lastProgress = useRef<{ readonly status: SupervisorSummary['status']; readonly done: number } | null>(null)
    // One handler for both DNA switches: opening DNA from the browser must also
    // park the trend's Total/Delta switch at Total, or the chart plots total
    // while the Delta segment still looks selected.
    const setDnaMode = (next: boolean): void => {
      setDna(next)
      setTrendMode(mode => modeAfterDnaChange(next, mode))
    }
    // Strip-clicked turn: chart switches to turn granularity and scroll-centers that turn's bar, then clears via onFocusTurnHandled.
    const [focusTurn, setFocusTurn] = useState<number | null>(null)
    // Chat → Context jump: the assistant-action relay's one-shot request, held until the projection data is in, then resolved into a
    // turn-level pin below (mirrors the strip-click's consume-once focus flow).
    const [jumpSeq, setJumpSeq] = useState<number | null>(null)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    // The browser's open category: the trend card focuses its bars on it (collapsing the category restores all).
    const [focusCat, setFocusCat] = useState<string | null>(null)
    const [pickedKinds, setPickedKinds] = useState<string[]>([...EVENT_KINDS])
    const toggleKind = (k: string) => {
      setPickedKinds((p) => {
        if (p.length === EVENT_KINDS.length) return [k]
        if (!p.includes(k)) return [...p, k]
        return p.length === 1 ? [...EVENT_KINDS] : p.filter(x => x !== k)
      })
    }
    // Step-brief → browser reveal bridge: one-shot focus request consumed by the Context browser.
    const [nodeFocus, setNodeFocus] = useState<{ step: number | 'live'; seq: number; cat: SurfaceNode['cat'] } | null>(null)
    const clearNodeFocus = useCallback(() => { setNodeFocus(null) }, [])

    // Session-authorized durable-image loader for the browser's attachment cards, resolved through the harness `uiConversation` service
    // (`imageUrl`); absent service/session degrades the cards to metadata-only, never an error.
    const loadImage = useMemo(
      () => imageLoaderOf(ctx, typeof sessionId === 'string' ? sessionId : undefined),
      [ctx, sessionId],
    )

    // The gateway page face, as a React seat: the first render can race the
    // declared inject (a watch rebuild remounts this view before the fiber
    // re-fires), and both fetchers below must rebuild — not stick to the
    // static degradation — when the face lands or is revoked.
    const historyFace = useHistoryFace()

    // Targeted full-content fetch for browser nodes outside the conversation window (one seq-anchored history read per expanded row);
    // absent face/session degrades to the static hint — never an error.
    const fetchContent = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' && historyFace !== undefined
        ? makeContentFetcher(sessionId)
        : undefined),
      [sessionId, historyFace],
    )
    // On-demand header epoch content (system prompt text, tool schemas) for the Context browser — one seq-anchored history read per
    // opened epoch; the `redlineHeaders` projection carries metadata only. Same degradation shape as fetchContent.
    const fetchHeader = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' && historyFace !== undefined
        ? makeHeaderFetcher(sessionId)
        : undefined),
      [sessionId, historyFace],
    )

    const rootRef = useRef<HTMLDivElement | null>(null)
    const scrollerRef = useRef<HTMLElement | null>(null)
    // The session whose position was already applied this mount — re-applying on re-renders would yank the reader's scroll.
    const restoredRef = useRef<string | null>(null)

    // 只在面板真的可见时，让那两条改**宿主**元素的 CSS 生效（见 surfaceVisibility.ts）。
    useSurfaceVisibility(rootRef)

    // Restore the saved position (or the top on first visit) in a layout effect, so the chat's bottom-anchored position never flashes in
    // first.
    useLayoutEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '' || data === null) return
      if (restoredRef.current === sessionId) return
      restoredRef.current = sessionId
      /* v8 ignore next 3 -- a layout effect body only runs while mounted and
         both render paths attach rootRef, so the null arm cannot fire. */
      const scroller = rootRef.current !== null
        ? rootRef.current.closest('[data-conversation-scroll]')
        : null
      if (scroller === null) return
      scrollerRef.current = scroller as HTMLElement
      scroller.scrollTop = viewScroll.get(sessionId) ?? 0
    }, [sessionId, data])

    // Save the position on unmount/session change — a layout-effect cleanup, so it fires before the incoming view's own layout effects
    // re-scroll the shared container.
    useLayoutEffect(() => {
      return () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const scroller = scrollerRef.current
        if (scroller === null) return
        viewScroll.set(sessionId, scroller.scrollTop)
      }
    }, [sessionId])

    // No locale subscription here: the harness slot outlet subscribes the
    // LocaleFace revision and re-renders every entry on a locale switch, and
    // the kit's bound `t` reads the active locale at call time.

    // Hooks stay unconditional (Rules of Hooks): the projection value can arrive AFTER a loading first render, and an early return above
    // these useMemos would grow the hook count between renders (React #310); fall back to empty collections and keep the loading return
    // below the last hook.
    const requests = data ? data.requests : []
    const events = data ? data.events : []
    // The stats board's count figures — the split head's precomputed tallies, or
    // the collections' own derivation on the inline generation. Shared by the
    // stats card's shape cells and the events card's kind-filter counts.
    const counts = data?.counts ?? countsOfRecords(requests, events)
    // The per-kind tallies that ride the filter buttons: only the three priced
    // kinds the host counts (model/mode switches carry no tally, hence undefined).
    const kindCounts: Record<string, number | undefined> = { inject: counts.injects, compaction: counts.compactions, prune: counts.prunes }
    const shownEvents = pickedKinds.length === EVENT_KINDS.length ? events : events.filter(e => pickedKinds.includes(e.kind))
    // Per-step bars, or one per turn (each turn's LAST step's record); memoized so hover-driven re-renders keep bar props identity-stable —
    // the chart's memoized bars then skip reconciliation (turn-mode aggregation allocates).
    const displayRequests = useMemo(
      () => (granularity === 'turn' ? aggregateByTurn(requests) : requests),
      [requests, granularity],
    )
    // The step labels' per-turn totals ("第 s 步 (共 n 步)"), tallied over the RAW step records — turn-mode
    // aggregates read their own stepCount instead.
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const markers = useMemo(() => attachMarkers(displayRequests, events), [displayRequests, events])
    // DNA mode's per-bar bands: one assemble() per displayed record, memoized on
    // the timeline so hover-driven re-renders never reassemble.
    const dnaBands = useMemo(
      () => (dna && data !== null ? displayRequests.map(req => trendBandsOf(assemble(data, headers, req.seq))) : null),
      [dna, data, headers, displayRequests],
    )

    // Supervisor run status: a per-session polling read; a session without a run
    // answers `null` and renders no card, so ordinary conversations stay untouched.
    useEffect(() => {
      // A pending second click belongs to the session it was armed in, and so
      // does the card: showing session A's run while session B is selected is
      // worse than showing nothing.
      setRollbackArmed(false)
      setSupervisorError(null)
      setSupervisor(null)
      setSupervisorBusy(false)
      // The explicit judge pick belongs to the session it was made in.
      setSwitchTarget('')
      setSwitchEffort('')
      // The catalog belongs to the blocked run of the previous session; keeping
      // it would paint that session's models into the next one's picker.
      setSwitchModels([])
      setGoalResumeHint(false)
      setResumeRefused(null)
      lastProgress.current = null
      rollbackGeneration.current += 1
      // A poll of the previous session must never land on this one either.
      supervisorPollGen.current += 1
      if (typeof sessionId !== 'string' || sessionId === '') return
      let cancelled = false
      const load = (): void => {
        const generation = supervisorPollGen.current
        void readSupervisor(sessionId).then((answer) => {
          if (cancelled || supervisorPollGen.current !== generation) return
          // a refusal here is "this session has no live run", not an error to show
          const value = answer.ok ? answer.value : null
          const previous = lastProgress.current
          // A finished run cannot still be waiting to be resumed, and a run that
          // advanced to another task has already been driven again: both make
          // the previous action's notice stale. A FAILED poll proves neither, so
          // it leaves the notice alone.
          const stale = answer.ok && (value === null || value.status === 'completed'
            || (previous !== null && value.done > previous.done))
          if (stale) {
            setGoalResumeHint(false)
            setResumeRefused(null)
          }
          // A refusal describes a BLOCKED run. A poll that shows it unblocked
          // proves the notice stale even when `done` did not move: another tab's
          // `guard.continue` or fallback switch clears a block in place, and a
          // multi-tab rollback can even lower `done` — neither is visible to the
          // progress comparison above. The baseline's status is what makes this
          // a real transition: without one there is no notice to clear.
          const unblocked = answer.ok && value !== null
            && value.status !== 'blocked'
            && value.blockedReason === undefined
            && !value.tasks.some(task => task.status === 'BLOCKED')
            && previous?.status === 'blocked'
          if (unblocked) setResumeRefused(null)
          if (answer.ok) lastProgress.current = value === null ? null : { status: value.status, done: value.done }
          setSupervisor(value)
        })
      }
      load()
      const timer = setInterval(load, 3000)
      return () => { cancelled = true; clearInterval(timer) }
    }, [sessionId])

    // A blocked run without a configured fallback is the zenspace case: the card
    // must still be able to name a judge, so load the catalog on demand. The
    // dependency is the BLOCK itself, not the run status: a task can flip to
    // BLOCKED while the run-level status stays `active`, and watching only
    // `supervisor?.status` left the picker empty for exactly that transition.
    const blockedRun = supervisor !== null
      && (supervisor.blockedReason !== undefined
        || supervisor.status === 'blocked'
        || supervisor.tasks.some(task => task.status === 'BLOCKED'))
    // The ledger and the host goal disagree when the driver stopped without a
    // supervisor block: a round-limit stop or the session-start disarm leaves
    // `tasks.json` saying `active` while nothing will run another turn. That is
    // a real state the card must show, and 继续 is how a human repairs it.
    const hostGoal = supervisor?.hostGoal
    const hostStopped = supervisor !== null && supervisor.status === 'active'
      && hostGoal !== undefined
      && (hostGoal.phase !== 'active' || hostGoal.activation !== 'armed')
    const recoverable = blockedRun || hostStopped
    const effectiveStatus = supervisor === null || supervisor.status !== 'active' || hostGoal === undefined
      ? supervisor?.status ?? 'active'
      : hostGoal.phase === 'blocked'
        ? 'blocked'
        : hostGoal.phase === 'complete'
          ? 'completed'
          : hostGoal.phase === 'paused' || hostGoal.activation === 'disarmed'
            ? 'paused'
            : 'active'
    // A run read from disk while its session is unloaded cannot be acted on:
    // loading the catalog would offer a switch that the host must refuse.
    const supervisorAgentDown = supervisor !== null && supervisor.agentLive === false
    useEffect(() => {
      if (!blockedRun || supervisorAgentDown || typeof sessionId !== 'string' || sessionId === '') return
      let cancelled = false
      void readCarrierModels().then((answer) => {
        if (cancelled || !answer.ok) return
        setSwitchModels(answer.value.models.map(model => ({
          provider: model.provider,
          model: model.model,
          label: `${model.provider}/${model.model}`,
          efforts: model.efforts,
        })))
      })
      return () => { cancelled = true }
    }, [blockedRun, supervisorAgentDown, supervisor?.runId, sessionId])

    // One place for every action answer: the summary replaces the polled one and
    // the two action-only notices are re-derived from THIS reply, so a later
    // poll cannot silently drop the warning.
    const applySupervisorAnswer = (value: SupervisorSummary | null): void => {
      // Any poll still in flight read a ledger older than this reply.
      supervisorPollGen.current += 1
      setSupervisor(value)
      setGoalResumeHint(value?.goalResumed === false)
      setResumeRefused(value?.resumeRefused ?? null)
      // The reply's progress is the baseline the next poll compares against;
      // otherwise a poll that repeats the reply's own numbers would look like
      // progress and clear a warning the action just raised.
      lastProgress.current = value === null ? null : { status: value.status, done: value.done }
    }

    // Rollback is destructive (it reverts commits and restores the reopened
    // task's scope to the checkpoint): arm on the first click, execute on the
    // second, so a stray click never rewrites history.
    const rollbackSupervisorRun = (): void => {
      if (supervisor === null || supervisorBusy || typeof sessionId !== 'string' || sessionId === '') return
      if (!rollbackArmed) { setRollbackArmed(true); return }
      setRollbackArmed(false)
      // A poll in flight read the pre-rollback ledger; this action's reply is
      // newer than anything that request can return.
      supervisorPollGen.current += 1
      setSupervisorBusy(true)
      setSupervisorError(null)
      // The previous action's notice describes a different request; keeping it
      // beside this one would report two outcomes at once.
      setGoalResumeHint(false)
      setResumeRefused(null)
      // A response that lands after the user switched sessions must not paint
      // this session's result onto the next one.
      const generation = rollbackGeneration.current
      void rollbackSupervisor(sessionId, supervisor.runId).then((answer) => {
        if (rollbackGeneration.current !== generation) return
        setSupervisorBusy(false)
        if (answer.ok) { applySupervisorAnswer(answer.value); return }
        // A failed rollback is actionable: the host says which checkpoint or
        // file is in the way, so surface it instead of going silent. Keep the raw
        // message (an empty one must render the title alone, not the title twice);
        // the localized template is applied at render time.
        setSupervisorError({ action: 'rollback', message: answer.message })
      })
    }

    // A blocked run is one click away from continuing: the block exists to stop
    // an unusable judge from passing anything, not to make the human roll the
    // task back (which would reopen it and lose its base commit).
    const resumeSupervisorRun = (): void => {
      if (supervisor === null || supervisorBusy || typeof sessionId !== 'string' || sessionId === '') return
      supervisorPollGen.current += 1
      setSupervisorBusy(true)
      setSupervisorError(null)
      setGoalResumeHint(false)
      setResumeRefused(null)
      const generation = rollbackGeneration.current
      void resumeSupervisor(sessionId, supervisor.runId).then((answer) => {
        if (rollbackGeneration.current !== generation) return
        setSupervisorBusy(false)
        if (answer.ok) { applySupervisorAnswer(answer.value); return }
        setSupervisorError({ action: 'resume', message: answer.message })
      })
    }

    // A blocked run may be blocked BECAUSE the judge is unusable: switching to the
    // configured fallback is the recovery, and it resumes in the same action.
    const switchSupervisorModel = (role: 'executor' | 'evaluator'): void => {
      if (supervisor === null || supervisorBusy || typeof sessionId !== 'string' || sessionId === '') return
      supervisorPollGen.current += 1
      setSupervisorBusy(true)
      setSupervisorError(null)
      setGoalResumeHint(false)
      setResumeRefused(null)
      const generation = rollbackGeneration.current
      void switchSupervisor(sessionId, { runId: supervisor.runId, role, resume: true }).then((answer) => {
        if (rollbackGeneration.current !== generation) return
        setSupervisorBusy(false)
        if (answer.ok) { applySupervisorAnswer(answer.value); return }
        setSupervisorError({ action: 'switch', message: answer.message })
      })
    }

    // Explicit judge switch for a run whose configured routes are unusable — the
    // card must keep offering it even when a fallback is configured.
    const switchEvaluatorTo = (): void => {
      if (supervisor === null || supervisorBusy || switchTarget === '' || typeof sessionId !== 'string') return
      const picked = switchModels.find(model => `${model.provider}/${model.model}` === switchTarget)
      if (picked === undefined) return
      // Only a level this model actually advertises; a stale selection from the
      // previous model must not reach the host.
      const effort = picked.efforts.some(level => level.id === switchEffort) ? switchEffort : ''
      supervisorPollGen.current += 1
      setSupervisorBusy(true)
      setSupervisorError(null)
      setGoalResumeHint(false)
      setResumeRefused(null)
      const generation = rollbackGeneration.current
      void switchSupervisor(sessionId, {
        runId: supervisor.runId,
        role: 'evaluator',
        route: {
          provider: picked.provider,
          model: picked.model,
          ...(effort === '' ? {} : { reasoningEffort: effort }),
        },
        resume: true,
      }).then((answer) => {
        if (rollbackGeneration.current !== generation) return
        setSupervisorBusy(false)
        if (answer.ok) { applySupervisorAnswer(answer.value); setSwitchTarget(''); setSwitchEffort(''); return }
        setSupervisorError({ action: 'switch', message: answer.message })
      })
    }

    const supervisorCard = supervisor === null ? null : (() => {
      const currentTask = supervisor.tasks.find(task => task.id === supervisor.currentTaskId)
      const blocked = supervisor.tasks.find(task => task.status === 'BLOCKED')
      const pickedSwitch = switchModels.find(model => `${model.provider}/${model.model}` === switchTarget)
      // Once a role already runs on its fallback route, "switch to the fallback"
      // is a no-op button that only looks like a recovery action.
      const executorOnFallback = supervisor.activeExecutorModel !== undefined
        && supervisor.activeExecutorModel === supervisor.executorFallbackModel
      const evaluatorOnFallback = supervisor.evaluatorModel !== undefined
        && supervisor.evaluatorModel === supervisor.evaluatorFallbackModel
      const chip = `redline-guard-chip redline-guard-chip-${effectiveStatus}`
      // A host-side stop (round limit / paused / disarmed) is the OTHER way a run
      // goes quiet while the ledger still says `active`; without this row the
      // card rendered a dead run as "running" forever.
      const hostGoalRow = hostGoal === undefined || !hostStopped
        ? null
        : h('div', {
          className: hostGoal.phase === 'blocked'
            ? 'redline-guard-alert redline-guard-alert-error'
            : 'redline-guard-alert redline-guard-alert-warn',
          role: 'alert',
          'data-redline-supervisor-host-goal': hostGoal.phase,
        },
        hostGoal.phase === 'blocked'
          ? t('supervisor.hostGoalBlocked', {
            code: hostGoal.blockedCode ?? hostGoal.phase,
            reason: hostGoal.blockedMessage ?? '',
          })
          : t('supervisor.hostGoalStopped', {
            rounds: hostGoal.roundsStarted === undefined || hostGoal.maxGoalRounds === undefined
              ? ''
              : `（${hostGoal.roundsStarted}/${hostGoal.maxGoalRounds}）`,
          }))
      return h('div', { className: 'redline-card redline-guard-card', 'data-redline-supervisor-card': '1' },
        // Header: what this is, whether it is stuck, and how far it got.
        h('div', { className: 'redline-guard-head' },
          h('span', { className: 'redline-guard-title' }, t('supervisor.title')),
          h('span', { className: chip }, t(`supervisor.status.${effectiveStatus}`)),
          h('span', { className: 'redline-guard-progress' }, `${supervisor.done}/${supervisor.total}`)),
        h('div', { className: 'redline-guard-run', title: supervisor.runId }, t('supervisor.run', { runId: supervisor.runId })),
        currentTask === undefined ? null : h('div', { className: 'redline-guard-task' },
          t('supervisor.task', { id: currentTask.id, title: currentTask.title })),
        // A block is the one thing a human must act on: give it a callout, not a
        // red sentence lost among the metadata rows.
        blocked === undefined ? null : h('div', { className: 'redline-guard-alert redline-guard-alert-error', role: 'alert' },
          t('supervisor.blocked', { reason: blocked.blockedReason ?? '' })),
        // A run-level block is the plugin telling the host goal to stop; without
        // it on the card a stalled run looks identical to an idle one. A BLOCKED
        // sibling is a DIFFERENT fact (a parallel batch can have both), so only
        // hide this line when it would repeat the same sentence.
        hostGoalRow,
        supervisor.blockedReason === undefined || blocked?.blockedReason === supervisor.blockedReason
          ? null
          : h('div', { className: 'redline-guard-alert redline-guard-alert-error', role: 'status' },
            h('div', { className: 'redline-guard-alert-body' }, t('supervisor.runBlocked', { reason: supervisor.blockedReason }))),
        supervisor.setupError === undefined
          ? null
          : h('div', { className: 'redline-guard-alert redline-guard-alert-warn', role: 'alert' }, t('supervisor.setupError', { reason: supervisor.setupError })),
        supervisorError === null ? null : h('div', { className: 'redline-guard-alert redline-guard-alert-error', role: 'alert' },
          supervisorError.message.trim() === ''
            ? t(`supervisor.${supervisorError.action}Failed`)
            : t('supervisor.actionFailedDetail', {
              action: t(`supervisor.${supervisorError.action}Failed`),
              reason: supervisorError.message,
            })),
        goalResumeHint
          ? h('div', {
            className: 'redline-guard-note', role: 'status', 'data-redline-supervisor-goal-resume': '1',
          }, t('supervisor.goalNotResumed'))
          : null,
        resumeRefused === null
          ? null
          : h('div', {
            className: 'redline-guard-alert redline-guard-alert-error', role: 'alert', 'data-redline-supervisor-resume-refused': '1',
          }, t('supervisor.resumeRefused', { reason: resumeRefused })),
        supervisor.mirror?.issueUrl === undefined ? null : h('div', { className: 'redline-guard-eval' },
          h('a', { href: supervisor.mirror.issueUrl, target: '_blank', rel: 'noreferrer' }, t('supervisor.mirror'))),
        // An isolated run commits to its own branch and nothing merges it back,
        // so the card has to name the branch a human still has to merge.
        supervisor.worktreeBranch === undefined
          ? null
          : h('div', { className: 'redline-guard-eval', 'data-redline-supervisor-branch': '1' },
            t('supervisor.worktreeBranch', { branch: supervisor.worktreeBranch })),
        supervisor.evaluatorModel === undefined
          ? null
          : h('div', { className: 'redline-guard-eval', 'data-redline-supervisor-evaluator': '1' },
            t('supervisor.evaluator', { model: supervisor.evaluatorModel })),
        supervisor.evaluatorFallbackModel === undefined
          ? null
          : h('div', { className: 'redline-guard-eval', 'data-redline-supervisor-evaluator-fallback': '1' },
            t('supervisor.evaluatorFallback', { model: supervisor.evaluatorFallbackModel })),
        supervisor.executorModel === undefined
          ? null
          : h('div', { className: 'redline-guard-eval', 'data-redline-supervisor-executor': '1' },
            t('supervisor.executor', { model: supervisor.executorModel })),
        supervisor.activeExecutorModel === undefined || supervisor.activeExecutorModel === supervisor.executorModel
          ? null
          : h('div', { className: 'redline-guard-eval', 'data-redline-supervisor-active-executor': '1' },
            t('supervisor.activeExecutor', { model: supervisor.activeExecutorModel })),
        supervisor.executorModel?.startsWith('antigravity/') === true
          ? h('div', {
            className: 'redline-guard-note', 'data-redline-supervisor-executor-bridge': '1',
          }, t('supervisor.executorBridgeWarn'))
          : null,
        supervisor.visualWitness === true
          ? h('div', { className: 'redline-guard-eval', 'data-redline-supervisor-visual': '1' }, t('supervisor.visual'))
          : null,
        // The run was read from disk because this session is not loaded: say so
        // instead of hiding the card, or a restart reads as "my run vanished".
        supervisor.agentLive === false
          ? h('div', { className: 'redline-guard-note', role: 'status', 'data-redline-supervisor-down': '1' },
            t('supervisor.agentDown'))
          : null,
        !recoverable
          ? null
          : h('div', { className: 'redline-guard-actions' },
            // Recovery first; destructive last.
            h('button', {
              type: 'button', className: 'redline-confirm-btn redline-confirm-btn-ok', 'data-redline-supervisor-resume': '1',
              disabled: supervisorBusy || supervisor.agentLive === false, onClick: resumeSupervisorRun,
            }, t('supervisor.resume')),
            supervisor.executorFallbackModel === undefined || executorOnFallback
              ? null
              : h('button', {
                type: 'button', className: 'redline-confirm-btn redline-confirm-btn-cancel', 'data-redline-supervisor-switch-executor': '1',
                disabled: supervisorBusy || supervisor.agentLive === false,
                onClick: () => { switchSupervisorModel('executor') },
              }, t('supervisor.switchExecutor')),
            supervisor.evaluatorFallbackModel === undefined || evaluatorOnFallback
              ? null
              : h('button', {
                type: 'button', className: 'redline-confirm-btn redline-confirm-btn-cancel', 'data-redline-supervisor-switch-evaluator': '1',
                disabled: supervisorBusy || supervisor.agentLive === false,
                onClick: () => { switchSupervisorModel('evaluator') },
              }, t('supervisor.switchEvaluator')),
            null),
        // Rollback is not a recovery: it is offered whenever this run has any
        // recorded state, and stays usable when a run is read from disk.
        supervisor.tasks.some(task => task.status !== 'TODO')
          ? h('div', { className: 'redline-guard-actions' },
            h('button', {
              type: 'button', className: 'redline-confirm-btn redline-confirm-btn-danger', 'data-redline-supervisor-rollback': '1',
              disabled: supervisorBusy || supervisor.agentLive === false, onClick: rollbackSupervisorRun,
            }, rollbackArmed ? t('supervisor.rollbackArmed') : t('supervisor.rollback')))
          : null,
        // The configured fallback may itself be the unusable route, so the
        // explicit picker is offered whenever the catalog is known — never
        // hidden just because a fallback exists. Same picker style as the
        // creation dialog, so model + reasoning level read the same everywhere.
        switchModels.length === 0
          ? null
          : h('div', { className: 'redline-guard-switch' },
            h('select', {
              className: 'redline-guard-select', 'data-redline-supervisor-switch-target': '1',
              value: switchTarget, 'aria-label': t('supervisor.switchEvaluatorPick'),
              disabled: supervisorBusy || supervisor.agentLive === false,
              onChange: (event: ChangeEvent<HTMLSelectElement>) => {
                setSwitchTarget(event.target.value)
                setSwitchEffort('')
              },
            },
            h('option', { value: '' }, t('supervisor.switchEvaluatorPick')),
            ...switchModels.map(model => h('option', {
              key: `${model.provider}/${model.model}`, value: `${model.provider}/${model.model}`,
            }, model.label))),
            pickedSwitch === undefined || pickedSwitch.efforts.length === 0
              ? null
              : h('select', {
                className: 'redline-guard-select', 'data-redline-supervisor-switch-effort': '1',
                value: switchEffort, 'aria-label': t('supervisor.switchEffortPick'),
                disabled: supervisorBusy || supervisor.agentLive === false,
                onChange: (event: ChangeEvent<HTMLSelectElement>) => { setSwitchEffort(event.target.value) },
              },
              h('option', { value: '' }, t('supervisor.switchEffortDefault')),
              ...pickedSwitch.efforts.map(level => h('option', { key: level.id, value: level.id }, level.name))),
            h('button', {
              type: 'button', className: 'redline-confirm-btn redline-confirm-btn-ok', 'data-redline-supervisor-switch-apply': '1',
              disabled: supervisorBusy || supervisor.agentLive === false || switchTarget === '',
              onClick: switchEvaluatorTo,
            }, t('supervisor.switchApply'))))
    })()

    // Chat → Context jump, leg 1: pick up the assistant-action relay's request for this session —
    // once per mount, and again on every later record (the sidebar landing keeps this view mounted
    // while the user jumps between replies).
    useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const take = (): void => {
        const seq = takeContextFocus(sessionId)
        if (seq !== null) setJumpSeq(seq)
      }
      take()
      return subscribeContextFocus(take)
    }, [sessionId])

    // Leg 2: the action row belongs to the reply that CLOSED a turn, so the jump is turn-level — flip the chart to turn bars, pin that
    // turn's aggregate (the relayed seq is the turn's last request, exactly the aggregate's record), and center it: the same flow as a
    // turn-strip click. An aged-out turn clamps to the oldest retained bar. The landing then reveals the Current Composition card, so
    // the card and the pinned turn's trend chart share the scrollport (revealScroll.ts; no scrollable ancestor → a quiet no-op).
    // The split generation waits for the detail read first: the relayed seq resolves against the served request records, so the
    // one-shot request must not be consumed while the collections are still pending (it re-fires when they land).
    const detailReady = source.detailState === 'ready' || source.detailState === 'legacy'
    useEffect(() => {
      if (jumpSeq === null || data === null || !detailReady) return
      setJumpSeq(null)
      const target = jumpTargetOf(aggregateByTurn(requests), jumpSeq)
      if (target === null) return
      setGranularity('turn')
      setSelectedSeq(target.seq)
      setFocusTurn(target.turn ?? 0)
      // The restore layout effect already applied the saved position on this same data render
      // (layout effects precede this one); the reveal overrides it wherever it landed.
      /* v8 ignore next 2 -- the effect only fires while mounted, and both render paths attach
         rootRef and render the composition card. */
      const anchor = rootRef.current?.querySelector('[data-redline-current]') ?? null
      if (anchor !== null) revealInScrollParent(anchor)
    }, [jumpSeq, data, requests, detailReady])

    // Step-brief raw material: every served node seq-sorted (live tail + archive), and the conversation-snapshot
    // join the brief uses for call-argument enrichment (same join the Context browser builds).
    const briefList = useMemo(() => (data ? briefNodes(data) : []), [data])
    // The conversation-window join, from the `useChat` seat. The seat is a
    // real hook — invoked unconditionally per render (stable order);
    // undefined join = render without it, never an error.
    const convNodes = conversationNodesOf(props)
    const bySeq = useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    // Active bar / pin lookup — derived BEFORE the loading-return so the hooks below stay unconditional (React #310).
    let pinnedIdx = -1
    for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i].seq === selectedSeq) pinnedIdx = i
    const pinnedReq = pinnedIdx >= 0 ? displayRequests[pinnedIdx] : null
    let activeIdx = -1
    if (hoveredSeq !== null) {
      for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i].seq === hoveredSeq) { activeIdx = i; break }
    }
    if (activeIdx < 0) activeIdx = pinnedIdx
    if (activeIdx < 0 && displayRequests.length > 0) activeIdx = displayRequests.length - 1
    const activeReq = activeIdx >= 0 ? displayRequests[activeIdx] : null
    // The active bar's semantic identity ("what this step was about"); pure derivation over the served nodes, null when nothing is known.
    const brief = useMemo(
      () => (activeReq !== null ? briefOf(briefList, displayRequests, activeIdx) : null),
      [activeReq, briefList, displayRequests, activeIdx],
    )
    const convOf = useCallback((seq: number): ConversationNodeLike | undefined => bySeq.get(seq), [bySeq])

    // File activity follows the same active bar: the op-log generation reads the fold-derived records (full
    // session-log coverage); older hosts keep the conversation-window derivation. Recomputed when the brief
    // source, the conversation join, or the upper bound moves — hover/select elsewhere (composition chips,
    // kind filters) leaves every input reference untouched, so the walk is skipped on those renders.
    // The session's workspace root — './'-relative row paths when known; read per
    // render (an observable snapshot), so the next projection push re-renders with it.
    // The system-opener affordance rides the same ctx; both resolve before the early return.
    // The capability is an RPC answer now (the synchronous host-description fact is gone),
    // so it lands in state once the probe settles — inert file names until then; the
    // effect's cleanup drops an answer that arrives after the view unmounted.
    // The right-Sidebar preview opener (the same optional column the Context
    // tab itself registers into): resolved off `ctx` at mount, the face
    // re-proved per call, so an HMR reload's revocation never leaves a stale
    // opener. Absent face = no `onPreview` at all, and the card keeps its
    // system-open affordance untouched.
    // A brief row's reveal target: inputs/opener live in the picked step's OWN assembled surface; the response node (seq === the
    // request's) first appears in the NEXT step's surface — or the live surface when the last bar is picked.
    const locateNode = useCallback((node: SurfaceNode, isResponse: boolean): void => {
      /* v8 ignore next 1 -- locateNode is only wired to brief rows, and
         brief !== null guarantees activeReq !== null in the same closure. */
      if (activeReq === null) return
      const next = isResponse && activeIdx + 1 < displayRequests.length ? displayRequests[activeIdx + 1] : null
      const step: number | 'live' = isResponse ? (next !== null ? next.seq : 'live') : activeReq.seq
      setNodeFocus({ step, seq: node.seq, cat: node.cat })
    }, [activeReq, activeIdx, displayRequests])

    // Hooks must remain above the loading return: one mounted view may move from undefined projection to ready data.
    const redline = useRedlineDrafts(typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined)
    const children = useChildSessions(
      typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined,
      childCatalog,
    )

    if (!data) {
      return <div className="redline-root" ref={rootRef}><div className="redline-empty">{t('loading')}</div></div>
    }

    const markerOf = (req: RequestRecord): ContextEventRecord | undefined => {
      const i = displayRequests.indexOf(req)
      /* v8 ignore next 1 -- the only caller passes displayRequests[activeIdx],
         an element of the very array indexOf scans. */
      return i >= 0 ? markers[i] : undefined
    }

    // Provider-anchored CURRENT occupancy (contextPressure.projectedTokens): the headline, because the fixed 4-chars/token heuristic
    // undercounts CJK by ~10–15% — proportions stay heuristic but are anchored to the real billed total. Shared with the /redline popup
    // (headline.ts); composition rides the official `contextBreakdown` rows.

    // Turn highlight is hover-only: the turn strip hover wins, then the hovered bar's turn — no fallback, so a pinned or default selection
    // never keeps a turn glowing.
    let activeTurn: number | null = hoverTurn
    if (activeTurn === null && hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) { activeTurn = req.turn ?? null; break }
    }

    // The trend card mirrors the SAME shared category hover the browser's live link uses: the overview's 'free' key drops
    // (no segment in the chart or the detail bar), and every bar + the detail bar light that category's segment.
    const trendHoverCat = hoverCat !== null && hoverCat !== 'free' ? hoverCat : null

    // The cost cell prices in the active locale (zh → CNY, else USD), read at render time — the locale subscription above already
    // The host's baseline gate (host/fallback.ts): the cards below render
    // the fallback's zeroed data while the modal names both versions and
    // urges the upgrade. Absent record = a supported harness, no gate.
    const gate = unsupportedOf(data.unsupported)

    // The three main-row cards, built once and laid out by the shared
    // arrangement below (every host uses the same row).
    const trendCard = (
      <div className="redline-card">
        <div className="redline-card-title">
          <span className="redline-card-title-text">{t('trend.title')}</span>
          {/* 规模读数（`docs/03` R1.5，与 demo 的 `granLabel` 同一句）：`按轮次（共 N 轮）` / `按步骤（共 N 次请求）`。
              单独一个 class：`.redline-card-sub` 是**聚焦**那一行，两者语义不同（混用会让"没聚焦⇒没有副标题"的契约失真）。 */}
          {/* Display modifiers ride the title's right as one segmented group: Adaptive rescales the bars to
              the visible window, Duration overlays each step's active time as a curve. */}
          <span className="redline-gran redline-trend-mods" role="group">
            <button
              type="button"
              className={'redline-gran-btn' + (dna ? ' redline-gran-on' : '')}
              title={t('trend.dnaTip')}
              onClick={() => { setDnaMode(!dna) }}
            >{t('trend.dna')}</button>
            <button
              type="button"
              className={'redline-gran-btn' + (adaptive ? ' redline-gran-on' : '')}
              title={t('trend.adaptiveHint')}
              onClick={() => { setAdaptive(on => !on) }}
            >{t('trend.adaptive')}</button>
            <button
              type="button"
              className={'redline-gran-btn' + (durationCurve ? ' redline-gran-on' : '')}
              title={t('trend.durationHint')}
              onClick={() => { setDurationCurve(on => !on) }}
            >{t('trend.duration')}</button>
          </span>
          <div className="redline-trend-ctl">
            <div className="redline-gran">
              <button
                className={'redline-gran-btn' + (granularity === 'step' ? ' redline-gran-on' : '')}
                onClick={() => { setGranularity('step') }}
              >{t('gran.step')}</button>
              <button
                className={'redline-gran-btn' + (granularity === 'turn' ? ' redline-gran-on' : '')}
                onClick={() => { setGranularity('turn') }}
              >{t('gran.turn')}</button>
            </div>
            <div className="redline-gran" title={t('gran.modeHint')}>
              <button
                className={'redline-gran-btn' + (trendMode === 'total' ? ' redline-gran-on' : '')}
                onClick={() => { setTrendMode('total') }}
              >{t('gran.total')}</button>
              <button
                className={'redline-gran-btn' + (trendMode === 'delta' ? ' redline-gran-on' : '')}
                disabled={dna}
                onClick={() => { setTrendMode('delta') }}
              >{t('gran.delta')}</button>
            </div>
          </div>
        </div>
        {displayRequests.length === 0
          // Split generation, first detail read pending or failed: say
          // so instead of claiming the session has no history.
          ? (detailReady
            ? <div className="redline-empty">{t('trend.empty')}</div>
            : <DetailNote state={source.detailState === 'failed' ? 'failed' : 'loading'} onRetry={source.retryDetail} />)
          : (
            <div>
              <TrendChart
                // Remount per session: switching sessions re-anchors the chart at the newest bars instead of inheriting stale scroll
                // state.
                key={sessionId}
                // Render ALL retained requests (bounded by the host's maxKeptTurns/maxRequestSteps config) so earlier turns/steps
                // stay reachable via horizontal scroll.
                requests={displayRequests}
                markers={markers}
                selectedSeq={pinnedReq ? pinnedReq.seq : null}
                hoveredSeq={hoveredSeq}
                activeTurn={activeTurn}
                granularity={granularity}
                mode={trendMode}
                focusTurn={focusTurn}
                hoverCat={trendHoverCat}
                focusCat={focusCat}
                adaptive={adaptive}
                durationCurve={durationCurve}
                dna={dnaBands}
                onSelect={setSelectedSeq}
                onHover={setHoveredSeq}
                onHoverTurn={setHoverTurn}
                onPickTurn={(turn) => { setGranularity('turn'); setFocusTurn(turn) }}
                onFocusTurnHandled={() => { setFocusTurn(null) }}
              />
              <RequestDetail
                request={activeReq}
                // Delta mode pairs the detail with the SAME previous record the chart diffs against (first bar: null).
                prev={trendMode === 'delta' && activeIdx >= 0 ? (activeIdx > 0 ? displayRequests[activeIdx - 1] : null) : undefined}
                /* v8 ignore next 1 -- RequestDetail renders only when
                   displayRequests.length > 0, which forces activeReq
                   non-null via the activeIdx fallback above. */
                marker={activeReq !== null ? markerOf(activeReq) : undefined}
                brief={brief}
                convOf={convOf}
                stepsOf={stepsOf}
                onLocate={locateNode}
                hoverKey={trendHoverCat}
              />
            </div>
          )}
      </div>
    )
    const browserCard = (
      <ContextBrowser
        redline={redline}
        data={data}
        headers={headers}
        convNodes={convNodes}
        fetchContent={fetchContent}
        fetchHeader={fetchHeader}
        previewSeq={hoveredSeq}
        pinSeq={pinnedReq !== null ? pinnedReq.seq : null}
        hoverKey={hoverCat}
        onHoverKey={setHoverCat}
        onOpenCat={setFocusCat}
        nodeFocus={nodeFocus}
        onNodeFocusHandled={clearNodeFocus}
        loadImage={loadImage}
        detailState={source.detailState}
        onDetailRetry={source.retryDetail}
        dna={dna}
        onDnaChange={setDnaMode}
      />
    )

    // 统计卡那 3 格的数据：`assemble()` 给出"这一步的列表"（含在那一步还活着、如今已被接替的原文），
    // 三个数字由纯函数 `stepStatsOf()` 从同一张列表里数出来 —— 与浏览器卡片列出的行**同一个来源**。
    const stepStats = stepStatsOf(assemble(data, headers, activeReq !== null ? activeReq.seq : null))
    return (
      <div className="redline-root" ref={rootRef}>

        {/* 两列各自从顶部向下排：左边看趋势/发生了什么，右边看上下文/改完后开子会话。
            不把另一列的高度带进定位，避免传统行式布局造成的顶部空洞；窄处自动成一列。
            统计卡是**左列第一张卡**（demo 的顺序），不再是顶部整宽横幅 —— 整宽时它的三格
            会被拉成三大行，既不像 demo 也浪费首屏。右侧栏面板（窄列）不放它（`docs/03` R5.1）。 */}
        <div className="redline-masonry">
          <div className="redline-masonry-col">
            {supervisorCard}
            {inSidebar ? null : (
              <StatsContext stats={stepStats} turn={activeReq?.turn} step={activeReq?.step}
                live={activeReq === null} ready={source.detailState === 'ready' || source.detailState === 'legacy'} />
            )}
            {trendCard}
            <div className="redline-card">
              <div className="redline-card-title">
                <span className="redline-card-title-text">{t('events.title')}</span>
                <div className="redline-kinds @max-[380px]/redline-card:flex-wrap">
                  {EVENT_KINDS.map((k) => {
                    const n = kindCounts[k]
                    return (
                      <button
                        key={k}
                        data-redline-kind={k}
                        className={'redline-gran-btn' + (pickedKinds.includes(k) ? ' redline-gran-on redline-kind-' + k : '')}
                        onClick={() => { toggleKind(k) }}
                      >
                        {t('kind.' + k)}
                        {n !== undefined ? <span className="redline-kind-n">{kit.fmt(n)}</span> : null}
                      </button>
                    )
                  })}
                </div>
              </div>
              <EventList events={shownEvents} state={source.detailState} onRetry={source.retryDetail} />
            </div>
          </div>

          <div className="redline-masonry-col">
            {browserCard}
            {/* 第 5 张卡（`docs/10` M3-16/17，随 M5 落地）：子会话索引 + 开子会话。
                它是**本面板唯一会写会话的入口**，所以按钮的门禁与 `保存` 完全一致（`live` / `turnOpen`）。 */}
            <ChildCard
              sessionId={sessionId}
              rows={children.rows}
              capacity={children.capacity}
              originsKnown={children.originsKnown}
              originsError={children.originsError}
              models={children.models}
              live={redline.turn.known}
              turnOpen={redline.turn.open}
              carriedCount={Object.keys(redline.table).length}
              plan={children.plan}
              start={children.start}
              planAnchor={children.planAnchor}
              readRepo={children.readRepo}
              prepareGuard={children.prepareGuard}
              startAnchor={children.startAnchor}
              openSession={(id) => { openSessionVia(ctx, id) }}
            />
          </div>
        </div>


        <div className="redline-foot">{t('footer')}</div>

        {gate !== null && (
          <UpgradeGate sessionId={sessionId} current={gate.current} minimum={gate.minimum} />
        )}
      </div>
    )
  }

  const ChildCard = makeChildCard(kit)

  return function ContextView(props: ContextViewProps): ReactElement {
    return h(ErrorBoundary, null, h(ContextViewBody, props))
  }
}
