import type { FastifyInstance } from 'fastify';

import { INGEST_API_PATH, INGEST_MAX_BODY_BYTES } from '../../../../../core/src/constants.js';
import type { IngestService } from '../../../ingestService.js';

/** POST /api/ingest: event batches from emitting clients. */
export function registerIngestRoute(app: FastifyInstance, ingest: IngestService): void {
  app.post(INGEST_API_PATH, { bodyLimit: INGEST_MAX_BODY_BYTES }, async (request, reply) => {
    const result = ingest.handle(request.headers.authorization, request.body);
    reply.code(result.status).send(result.body);
  });
}
