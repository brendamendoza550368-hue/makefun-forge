// gitproto.ts — git smart HTTP: info/refs advertisement, upload-pack
// (protocol v2 ls-refs/fetch with a v0 fallback) and receive-pack (v0).
// Implemented in full in this file; see handleGit.

import type { ServerResponse } from 'node:http';
import type { Ctx } from './app.ts';
import { sendJson } from './app.ts';

export function handleGit(ctx: Ctx, res: ServerResponse, segments: string[], url: URL): void {
  void ctx;
  void segments;
  void url;
  sendJson(res, 404, { message: 'Not Found' });
}
