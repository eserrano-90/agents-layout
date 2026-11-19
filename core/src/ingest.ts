/**
 * Hand-written companions to the generated ingest contract types.
 *
 * The contract itself lives in core/asyncapi.yaml and is generated into
 * ingestMessages.ts; this file only names shapes the generator inlines.
 */

import type { IngestEvent } from './ingestMessages.js';

/** Normalized, tool-agnostic agent event (the union carried by IngestEvent). */
export type AgentEvent = IngestEvent['event'];

/** One member of the AgentEvent union, selected by its `kind`. */
export type AgentEventOf<K extends AgentEvent['kind']> = Extract<AgentEvent, { kind: K }>;
