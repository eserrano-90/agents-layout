/**
 * Timing and scanning constants for the emitting client.
 *
 * Everything that observes the developer's machine (transcript polling, session
 * discovery, dismissal cooldowns, the loopback hook endpoint) is tuned here.
 * Wire-level constants shared with the server live in core/src/constants.ts.
 */

// ── Transcript polling ──────────────────────────────────────
/** How often each tracked session's transcript is checked for new lines. */
export const FILE_WATCHER_POLL_INTERVAL_MS = 500;
/** Largest chunk read from a transcript in one poll; the rest waits for the next poll. */
export const TRANSCRIPT_MAX_READ_BYTES = 65_536;
/** Teammate discovery and team-config membership check interval. */
export const PROJECT_SCAN_INTERVAL_MS = 1000;

// ── External session detection ──────────────────────────────
export const EXTERNAL_SCAN_INTERVAL_MS = 3000;
/** Only adopt transcripts modified within this window. */
export const EXTERNAL_ACTIVE_THRESHOLD_MS = 120_000; // 2 minutes
export const EXTERNAL_STALE_CHECK_INTERVAL_MS = 30_000;
/** A transcript born inside this window is replayed from its start on adoption. */
export const ADOPTION_FRESHNESS_WINDOW_MS = EXTERNAL_SCAN_INTERVAL_MS * 2;
/** Cooldown after a session ends. Must be > EXTERNAL_ACTIVE_THRESHOLD_MS so the
 *  transcript's mtime becomes stale before the dismissal expires. */
export const DISMISSED_COOLDOWN_MS = 180_000; // 3 minutes
/** How much of a transcript's head is inspected for the /clear marker. */
export const CLEAR_MARKER_SCAN_BYTES = 8192;

// ── Global session scanning ("watch all sessions") ──────────
/** Only adopt global transcripts larger than this (filters empty/init-only sessions). */
export const GLOBAL_SCAN_ACTIVE_MIN_SIZE = 3_072; // 3KB
/** Only adopt global transcripts modified within this window. */
export const GLOBAL_SCAN_ACTIVE_MAX_AGE_MS = 600_000; // 10 minutes

// ── Hook endpoint ───────────────────────────────────────────
/** Grace period after SessionEnd(reason=clear/resume) before the session is ended.
 *  /clear and /resume fire SessionEnd then SessionStart within ms; this is the
 *  safety net for when the follow-up never arrives. */
export const SESSION_END_GRACE_MS = 2000;
export const MAX_HOOK_BODY_SIZE = 65_536; // 64KB
/** Interface the loopback hook endpoint binds to. Never reachable from other machines. */
export const HOOK_ENDPOINT_HOST = '127.0.0.1';

// ── Delivery ────────────────────────────────────────────────
/** Give up on a single ingest request after this long and retry. */
export const INGEST_REQUEST_TIMEOUT_MS = 5000;
/** Longest a clean shutdown waits for the final batch to be delivered. */
export const SHUTDOWN_FLUSH_TIMEOUT_MS = 1500;

// ── Persistence ─────────────────────────────────────────────
export const CLIENT_STATE_FILE_NAME = 'client-state.json';
export const CLIENT_CONFIG_FILE_NAME = 'client.json';

// ── Environment ─────────────────────────────────────────────
export const ENV_SERVER_URL = 'PIXEL_AGENTS_URL';
export const ENV_TOKEN = 'PIXEL_AGENTS_TOKEN';
export const ENV_LABEL = 'PIXEL_AGENTS_LABEL';
