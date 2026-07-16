import type { ClientMessage, ServerMessage } from './messages.js';

/**
 * Transport-agnostic message layer between webview and server.
 *
 * Implementations:
 * - WebSocketTransport: connects to the standalone server over WebSocket
 */
export interface MessageTransport {
  /** Send a message to the extension/server. */
  send(message: ClientMessage): void;
  /** Subscribe to messages from the extension/server. Returns unsubscribe function. */
  onMessage(handler: (message: ServerMessage) => void): () => void;
  /** Clean up resources (WebSocket close, etc.). */
  dispose(): void;
}
