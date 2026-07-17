import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import Fastify from 'fastify';

import type { HttpServer, HttpServerHandle,HttpServerOptions } from '../../application/ports/HttpServer.js';
import { MAX_HOOK_BODY_SIZE } from '../../constants.js';
import { registerHealthRoute } from './plugins/healthPlugin.js';
import { registerHookRoute } from './plugins/hookPlugin.js';
import { registerStaticRoutes } from './plugins/staticPlugin.js';

export interface FastifyHttpAdapterOptions {
  embedded: boolean;
  token: string;
  staticDir?: string;
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  registerPlugins?: (app: FastifyInstance) => Promise<void>;
}

export class FastifyHttpAdapter implements HttpServer {
  private app: FastifyInstance | null = null;
  private currentPort = 0;

  constructor(private readonly opts: FastifyHttpAdapterOptions) {}

  async start(options: HttpServerOptions): Promise<HttpServerHandle> {
    const app = Fastify({
      logger: !this.opts.embedded,
      bodyLimit: MAX_HOOK_BODY_SIZE,
    });

    await app.register(fastifyCors, { origin: true });
    await app.register(fastifyWebsocket);

    if (!this.opts.embedded && this.opts.staticDir) {
      registerStaticRoutes(app, { staticDir: this.opts.staticDir });
    }

    registerHealthRoute(app);
    registerHookRoute(app, {
      token: this.opts.token,
      onHookEvent: this.opts.onHookEvent,
    });

    if (this.opts.registerPlugins) {
      await this.opts.registerPlugins(app);
    }

    await app.listen({ host: options.host ?? '127.0.0.1', port: options.port ?? 0 });
    const address = app.server.address();
    const port = typeof address === 'object' ? (address?.port ?? 0) : 0;

    this.app = app;
    this.currentPort = port;

    return { port };
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
      this.currentPort = 0;
    }
  }

  port(): number {
    return this.currentPort;
  }

  getApp(): FastifyInstance | null {
    return this.app;
  }
}
