/**
 * Shared constants used across server, extension, and webview.
 * Only constants needed by core interfaces live here.
 * Server-specific timing constants stay in server/src/constants.ts.
 * Webview-specific rendering constants stay in webview-ui/src/constants.ts.
 * Provider-specific constants stay in their provider directory.
 */

// ── Hook API ─────────────────────────────────────────────────

export const HOOK_API_PREFIX = '/api/hooks';
export const SERVER_JSON_DIR = '.pixel-agents';
export const SERVER_JSON_NAME = 'server.json';
export const HOOK_SCRIPTS_DIR = '.pixel-agents/hooks';

// ── Display ──────────────────────────────────────────────────

export const BASH_COMMAND_DISPLAY_MAX_LENGTH = 30;
export const TASK_DESCRIPTION_DISPLAY_MAX_LENGTH = 40;

// ── Ingest (emitting client → server) ────────────────────────

/** Path of the server endpoint that receives normalized event batches. */
export const INGEST_API_PATH = '/api/ingest';
/** Ingest contract version written by the bundled client. */
export const INGEST_PROTOCOL_VERSION = 1;
/** Ingest contract versions the server accepts. */
export const INGEST_SUPPORTED_VERSIONS: readonly number[] = [1];
/** A client flushes its queue as soon as this many events are waiting. */
export const INGEST_BATCH_MAX_EVENTS = 64;
/** A client flushes its queue at least this often while events are waiting. */
export const INGEST_FLUSH_INTERVAL_MS = 50;
/** Largest request body the ingest endpoint accepts. */
export const INGEST_MAX_BODY_BYTES = 1_048_576; // 1 MB
/** An idle client sends an empty batch this often so the server knows it is alive. */
export const CLIENT_HEARTBEAT_INTERVAL_MS = 10_000;
/** The server treats a client as gone after this long without a request. */
export const CLIENT_TIMEOUT_MS = 30_000;
/** Most events a client keeps while the server is unreachable; oldest are dropped. */
export const CLIENT_QUEUE_LIMIT = 5_000;
/** First retry delay after a failed delivery; doubles up to the maximum. */
export const INGEST_RETRY_BASE_MS = 250;
export const INGEST_RETRY_MAX_MS = 4_000;
