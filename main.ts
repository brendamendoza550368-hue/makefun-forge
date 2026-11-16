// Entry point: the harness lifecycle between this forge and the trial env.
//
// The contract, from the env's wire protocol:
//   - MAKEFUN_ENV_URL names the env's origin. With no env there is nothing to serve, so exit 1.
//   - The forge binds an ephemeral port (listen(0)); the env owns 8080 and must never be bound.
//   - POST {port} to $MAKEFUN_ENV_URL/register. The env records the caller's address plus the port
//     as the entry's base URL. 200 accepts; 409 means an earlier register already won and this
//     process simply waits like any other; 400/405 are contract errors and are fatal.
//   - Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}; the process never exits
//     before that, however many polls fail or time out.
//   - Then close the server and exit 0 so the harness can collect the export.
//
// This file wires the lifecycle only; the forge itself is built by createApp in app.ts.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: no env to register with\n');
  process.exit(1);
}

/** One register or poll request gets this long before it counts as failed. */
const REQUEST_TIMEOUT_MS = 30_000;
/** Retry waits grow exponentially from the first value to the cap. */
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The wait before retry number `attempt`: 250ms doubling, capped at 2s. */
function backoff(attempt: number): number {
  return Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** Math.min(attempt, 8));
}

/**
 * Register the bound port with the env, retrying transient failures. A 409 is success for our
 * purposes (the first register won); a 400 or 405 means the request itself is wrong, so throw.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal: Error | null = null;
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        fatal = new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch {
      // Network error or timeout: the env may still be starting, so fall through and retry.
    }
    if (fatal !== null) throw fatal;
    await wait(backoff(attempt));
  }
}

/** Poll the env's /done until it reports the trial is over. */
async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not answering yet is not done: keep polling.
    }
    await wait(backoff(attempt));
  }
}

/** Bind, register, wait for done, close: the process's whole life, in that order. */
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await untilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
