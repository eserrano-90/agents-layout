import type { MessageTransport } from './types.js';
import { WebSocketTransport } from './webSocketTransport.js';

function createTransport(): MessageTransport {
  // Standalone browser: connect via WebSocket to the same host serving the SPA.
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws`;
  const ws = new WebSocketTransport(wsUrl);
  ws.connect();
  return ws;
}

/** Singleton transport instance. Import this everywhere. */
export const transport: MessageTransport = createTransport();
export type { MessageTransport } from './types.js';
