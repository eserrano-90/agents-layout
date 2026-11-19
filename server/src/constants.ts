// ── Heuristic Agent Status Detection ────────────────────────
// Fallback when no hook event has been seen for an agent (hookDelivered = false).
/** Delay before sending agentToolDone (prevents UI flicker on rapid tool transitions) */
export const TOOL_DONE_DELAY_MS = 300;
/** Same delay for a sub-agent's tool finishing. */
export const SUBAGENT_TOOL_DONE_DELAY_MS = 300;
/** Heuristic: time after a non-exempt tool starts before showing the permission bubble.
 *  Not used for teammates -- false positives on slow tools (WebFetch/WebSearch). */
export const PERMISSION_TIMER_DELAY_MS = 7000;
/** Heuristic: silence duration before marking a text-only turn as complete */
export const TEXT_IDLE_DELAY_MS = 5000;

// ── Emitting clients ────────────────────────────────────────
/** How often client liveness is checked. */
export const CLIENT_LIVENESS_CHECK_INTERVAL_MS = 5_000;
/** File holding issued client tokens (hashes only). */
export const CLIENT_TOKENS_FILE_NAME = 'client-tokens.json';

// ── Layout/Config Persistence ──────────────────────────────
export const LAYOUT_FILE_DIR = '.pixel-agents';
export const LAYOUT_FILE_NAME = 'layout.json';
export const LAYOUT_FILE_POLL_INTERVAL_MS = 2000;
export const LAYOUT_REVISION_KEY = 'layoutRevision';
export const CONFIG_FILE_NAME = 'config.json';
export const USAGE_FILE_NAME = 'usage.json';
