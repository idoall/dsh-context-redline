/** Types for `scripts/release-check.mjs` (M6-10). */
export interface ReleaseStep {
  readonly label: string
  /** Which gate of {@link REQUIRED_GATES} this step covers. */
  readonly gate: string
  readonly command?: string
  /** The verdict-line fragment the step must see (`__NO_OUTPUT__` / `__EXIT0__` / `__PROGRESS__` are sentinels). */
  readonly expect: string
  readonly codeMustBeZero?: boolean
}
export declare const REQUIRED_GATES: readonly { readonly gate: string; readonly why: string }[]
export declare function planSteps(opts?: { withDsh?: boolean }): ReleaseStep[]
