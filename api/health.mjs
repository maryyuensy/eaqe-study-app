import {apiHandler} from '../lib/api.mjs';

export default apiHandler({
  GET: () => Response.json({status: 'ok', check: 'liveness'}),
  HEAD: () => new Response(null, {status: 200})
});
