import type { ClientMessage,ServerMessage } from '../../../../core/src/messages.js';

export interface MessageBus {
  broadcast(message: ServerMessage): void;
  onClientMessage(handler: (message: ClientMessage) => void): void;
  onConnectionState(handler: (connected: boolean) => void): void;
  dispose(): void;
}
