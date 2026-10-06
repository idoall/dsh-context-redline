// Client project setup: React 18 `act` requires this flag to flush effects
// synchronously in tests; every jsdom spec shares the real React runtime.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom does not implement scrollIntoView; the plugin calls it when focusing
// a browser row. A no-op polyfill stands in for the platform (layout-free).
if (typeof Element !== 'undefined' && Element.prototype.scrollIntoView === undefined) {
  Element.prototype.scrollIntoView = () => {}
}

// jsdom does not implement ResizeObserver either, and the harness primitives'
// Tooltip constructs one on mount (`@deepseek-ai/dsh-client-ui-primitives`,
// lib/index.js). Without it, specs that hover a tooltip die with
// `ReferenceError: ResizeObserver is not defined` — an environment gap, not a
// behaviour difference: jsdom has no layout, so an observer that never fires is
// exactly what a real browser would report for a zero-size box.
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub implements ResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver
}

