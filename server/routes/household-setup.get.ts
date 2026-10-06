import { readFileSync } from 'node:fs';
import { createError, getQuery, sendRedirect, setHeader } from 'h3';
export default defineEventHandler(event => {
  setHeader(event, 'Cache-Control', 'no-store');
  const remote = event.node.req.socket.remoteAddress;
  if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote ?? '')) throw createError({statusCode:403,statusMessage:'Open this setup page on the host computer using localhost'});
  const name = getQuery(event).name === 'molly' ? 'molly' : 'yuwei';
  const profiles = JSON.parse(readFileSync('.household-auth.json','utf8'));
  if (profiles[name]?.hash) return sendRedirect(event,'/household',302);
  const links = JSON.parse(readFileSync('.household-invites.json','utf8'));
  return sendRedirect(event,links[name],302);
});
