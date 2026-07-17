import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { HOOK_API_PREFIX } from '../../../constants.js';
import { createBearerAuth } from '../middleware/auth.js';

export interface HookPluginOptions {
  token: string;
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
}

export function registerHookRoute(app: FastifyInstance, options: HookPluginOptions): void {
  const authenticate = createBearerAuth(options.token);

  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
        const auth = request.headers.authorization;
        if (!authenticate(auth)) {
          reply.code(401).send('unauthorized');
        }
      },
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}
