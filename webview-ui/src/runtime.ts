/**
 * Runtime detection, provider-agnostic
 *
 * The webview ships only as the standalone browser SPA (served by the
 * `pixel-agents` CLI over WebSocket), so the runtime is always the browser.
 * Retained as a named constant because UI code gates browser-only behavior on
 * it (e.g. hiding the "+ Agent" launcher when there is no terminal to drive).
 */

export const isBrowserRuntime = true;

/**
 * True only under the Playwright e2e harness, which sets `__PIXEL_AGENTS_E2E`
 * via `addInitScript` before any app code runs (so it's set in every frame,
 * including the VS Code webview iframe). Gates test-only diagnostics
 * (window.__pixelAgentsTestHooks message/sound logs, the addAgent wrapper) so
 * they never run, and never grow unbounded, in a real user's session.
 */
export const isE2E: boolean =
  typeof window !== 'undefined' &&
  (window as unknown as { __PIXEL_AGENTS_E2E?: boolean }).__PIXEL_AGENTS_E2E === true;
