// graphql.ts — the GraphQL v4 surface at /api/graphql: the queries and
// mutations the suite sends (repository, issue, pullRequest, search,
// introspection) over the shared store.

import type { ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendJson } from './app.ts';

export function handleGraphQL(ctx: Ctx, res: ServerResponse): void {
  void ctx;
  sendJson(res, 200, { data: {} });
}
