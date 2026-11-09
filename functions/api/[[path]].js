import worker from '../../src/worker.js';

// Cloudflare Pages adapter: makes the protected API available at /api/* on
// the same domain as the public site and the /staff/ application.
export const onRequest = (context) => worker.fetch(context.request, context.env, context);
