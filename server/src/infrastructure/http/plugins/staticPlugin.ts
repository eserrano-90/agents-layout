import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export interface StaticPluginOptions {
  staticDir: string;
}

export function registerStaticRoutes(app: FastifyInstance, options: StaticPluginOptions): void {
  app.register(fastifyStatic, {
    root: options.staticDir,
    prefix: '/',
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.sendFile('index.html');
  });
}
