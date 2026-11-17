import {
  createDatabaseClient,
  createSiteContext,
  requireUser,
  errorResponse,
  BackendError,
} from './_qoder/backend.mjs';
import { createTechTree } from './tech.mjs';

const handle = createTechTree({ db: createDatabaseClient(), requireUser, BackendError });

Deno.serve(async (request) => {
  let context;
  try {
    context = createSiteContext(request);
    return await handle(context);
  } catch (error) {
    return errorResponse(error, context?.requestId);
  }
});
