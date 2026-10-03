/**
 * Types for `scripts/progress.mjs` (M6-12).
 *
 * The script itself stays plain `.mjs` so `node scripts/progress.mjs` runs with no
 * build step; this declaration is what lets the gate lane's spec (`tests/edit/
 * progress.spec.ts`) import it **without** `any` and without a suppression — which
 * is how the spec's assertions on `items` / `stages` stay type-checked.
 */

/** One task row of `docs/10`. */
export interface ChecklistItem {
  /** `M3-24`, `M05-52b`, … */
  readonly id: string
  /** The raw title cell (markdown intact). */
  readonly title: string
  /** One of {@link STATUSES}. */
  readonly status: string
  /** The `## N. …` heading this row sits under. */
  readonly stage: string
  /** The frozen file-scope cell. */
  readonly files: string
}

export interface ChecklistStage {
  readonly name: string
  readonly items: ChecklistItem[]
  /** Filled by the parser: `items.length`. */
  total?: number
  /** Filled by the parser: how many of them are DONE. */
  done?: number
}

export interface Checklist {
  readonly items: ChecklistItem[]
  /** Only the stages that actually hold rows. */
  readonly stages: ChecklistStage[]
  readonly totals: {
    readonly total: number
    readonly byStatus: Record<string, number>
  }
}

/** `['DONE', 'DOING', 'TODO', 'WAIT🙋']` — `WAIT🙋` is the only state that stops for the user. */
export declare const STATUSES: readonly string[]

/** Parse the checklist's task TABLE (never its §11 summary — see the script's header). */
export declare function parseChecklist(markdown: string): Checklist

/** Render the human report. `all: true` lists the finished items too. */
export declare function renderReport(cl: Checklist, opts?: { all?: boolean }): string
