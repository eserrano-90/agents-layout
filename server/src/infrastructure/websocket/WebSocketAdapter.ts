import type { FastifyInstance } from 'fastify';

import type { ClientMessage,ServerMessage } from '../../../../core/src/messages.js';
import type { AgentStateStore } from '../../agentStateStore.js';
import type { MessageBus } from '../../application/ports/MessageBus.js';
import type { ClientMessageContext } from '../../clientMessageHandler.js';
import { handleClientMessage } from '../../clientMessageHandler.js';
import type { AgentState } from '../../types.js';

export interface WebSocketAdapterOptions {
  store: AgentStateStore;
  /** Everything a browser message may need, minus the store. */
  context: Omit<ClientMessageContext, 'store'>;
  /** Label to show for an agent's client, or undefined when labels are hidden. */
  clientLabelFor?: (agent: AgentState) => string | undefined;
}

interface WsSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  readonly readyState: number;
}

export class WebSocketAdapter implements MessageBus {
  private sockets = new Set<WsSocket>();
  private clientHandlers: Array<(message: ClientMessage) => void> = [];
  private connectionHandlers: Array<(connected: boolean) => void> = [];
  private storeUnsubscribes: Array<() => void> = [];

  constructor(private readonly opts: WebSocketAdapterOptions) {}

  registerRoutes(app: FastifyInstance): void {
    app.get('/ws', { websocket: true }, (socket) => {
      const { store } = this.opts;
      this.sockets.add(socket);

      const onAgentAdded = (id: number, agent: AgentState) => {
        this.safeSend(socket, {
          type: 'agentCreated',
          id,
          folderName: agent.folderName,
          isExternal: agent.isExternal || undefined,
          isTeammate: agent.leadAgentId !== undefined || undefined,
          teammateName: agent.agentName,
          parentAgentId: agent.leadAgentId,
          teamName: agent.teamName,
          hooksOnly: agent.hooksOnly || undefined,
          clientLabel: this.opts.clientLabelFor?.(agent),
        });
      };

      const onAgentRemoved = (id: number) => {
        this.safeSend(socket, { type: 'agentClosed', id });
      };

      const onBroadcast = (message: Record<string, unknown>) => {
        this.safeSend(socket, message);
      };

      store.on('agentAdded', onAgentAdded);
      store.on('agentRemoved', onAgentRemoved);
      store.on('broadcast', onBroadcast);

      socket.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString()) as Record<string, unknown>;
          if (msg.type) console.log('[Pixel Agents] WS client message:', msg.type);
          handleClientMessage(msg, (m) => this.safeSend(socket, m), {
            ...this.opts.context,
            store,
          });
        } catch {
          // Malformed JSON, ignore
        }
      });

      socket.on('close', () => {
        this.sockets.delete(socket);
        store.off('agentAdded', onAgentAdded);
        store.off('agentRemoved', onAgentRemoved);
        store.off('broadcast', onBroadcast);
      });

      this.notifyConnectionHandlers(true);
    });
  }

  broadcast(message: ServerMessage): void {
    for (const socket of this.sockets) {
      this.safeSend(socket, message as unknown as Record<string, unknown>);
    }
  }

  onClientMessage(handler: (message: ClientMessage) => void): void {
    this.clientHandlers.push(handler);
  }

  onConnectionState(handler: (connected: boolean) => void): void {
    this.connectionHandlers.push(handler);
  }

  dispose(): void {
    for (const socket of this.sockets) {
      try { socket.close(1001, 'server shutdown'); } catch { /* ignore */ }
    }
    this.sockets.clear();
    this.clientHandlers = [];
    this.connectionHandlers = [];
    for (const unsub of this.storeUnsubscribes) {
      unsub();
    }
    this.storeUnsubscribes = [];
  }

  private safeSend(
    socket: WsSocket,
    message: Record<string, unknown>,
  ): void {
    if (socket.readyState === 1) {
      try {
        socket.send(JSON.stringify(message));
      } catch {
        // Connection may have closed
      }
    }
  }

  private notifyConnectionHandlers(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      handler(connected);
    }
  }
}
