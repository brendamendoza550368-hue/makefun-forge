// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over
// Streamable HTTP, tools backed by the same store as REST.

import type { ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendJson } from './app.ts';

export function handleMcp(ctx: Ctx, res: ServerResponse): void {
  void ctx;
  sendJson(res, 404, { message: 'Not Found' });
}
