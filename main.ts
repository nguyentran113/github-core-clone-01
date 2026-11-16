// The forge's entry point: it owns the short conversation with the make.fun env
// that brackets every trial, and nothing else. The forge itself lives in app.ts;
// this file only brings it up, introduces it to the env, and waits to be told
// the trial is over.
//
// The conversation, step by step:
//
//   * MAKEFUN_ENV_URL names the env's origin. If it is missing there is no
//     trial to join, so the process exits 1 before binding anything.
//   * The forge listens on port 0 and lets the kernel pick a free port. It
//     must never bind 8080: that port belongs to the env.
//   * The process announces the port with POST /register {"port": N}. The
//     first announcement wins the env's attention. A 200 means ours won; a
//     409 means another process registered first, which is equally final —
//     the env will drive that one, and this process simply waits like any
//     other. A 400 or 405 means the request itself broke the contract, so
//     retrying is pointless and the process fails at once. Anything else —
//     no answer, a reset connection, a 5xx — is treated as the env still
//     starting, and retried after a growing pause.
//   * The process then polls GET /done. The env answers each poll at once:
//     {"done": false} while its suite runs, {"done": true} once its export
//     is written. Only that true answer ends the wait; a failed or slow
//     poll is retried and never ends the process early.
//   * On done, the forge is closed and the process exits 0.
//
// The only import is the forge. Everything else used here (fetch, timers,
// AbortSignal, process) is a Node global, so the file needs no package and
// no built-in module.

import { createApp } from './app.ts';

/** How long a single register or done request may run before it is abandoned and retried. */
const REQUEST_LIMIT_MS = 30_000;

/** The pause after the first failed attempt; each further failure doubles it, up to PAUSE_LIMIT_MS. */
const PAUSE_FIRST_MS = 250;
const PAUSE_LIMIT_MS = 2_000;

/** Wait `ms` milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * The pause to take after `failures` consecutive failed attempts. The pause
 * doubles from PAUSE_FIRST_MS and stops growing at PAUSE_LIMIT_MS, so a
 * healthy-but-slow env is polled briskly at first and gently thereafter.
 */
function pauseAfter(failures: number): number {
  let ms = PAUSE_FIRST_MS;
  for (let i = 0; i < failures; i += 1) {
    ms = Math.min(PAUSE_LIMIT_MS, ms * 2);
  }
  return ms;
}

/** The env rejected the register request itself (HTTP 400 or 405): retrying cannot help. */
class RegisterRefused extends Error {
  constructor(status: number, body: string) {
    super(`register refused with HTTP ${status}${body === '' ? '' : `: ${body}`}`);
    this.name = 'RegisterRefused';
  }
}

/**
 * Announce `port` to the env until it has an entry address recorded. Returns
 * when a register has been answered 200 (ours recorded) or 409 (another
 * entry recorded first); throws RegisterRefused when the env rejects the
 * request outright. Every other outcome is retried with backoff, because
 * the env may still be coming up.
 */
async function announce(envUrl: string, port: number): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let status = -1;
    let body = '';
    try {
      const reply = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      status = reply.status;
      if (status === 400 || status === 405) body = await reply.text();
    } catch {
      status = -1; // no usable answer at all: count it as a failed attempt and retry
    }
    if (status === 200 || status === 409) return;
    if (status === 400 || status === 405) throw new RegisterRefused(status, body);
    await wait(pauseAfter(failures));
  }
}

/**
 * Poll the env's /done until it answers {"done": true}. A poll that fails,
 * times out, or answers anything else simply leads to the next poll after
 * a pause; this function returns only on the true answer.
 */
async function untilDone(envUrl: string): Promise<void> {
  for (let failures = 0; ; failures += 1) {
    let done = false;
    try {
      const reply = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.ok) {
        const payload: unknown = await reply.json();
        done =
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { done?: unknown }).done === true;
      }
    } catch {
      done = false; // the env is not answering yet: it is not done, so keep polling
    }
    if (done) return;
    await wait(pauseAfter(failures));
  }
}

/**
 * Bring the forge up on an ephemeral port and hand it to the env. Resolves
 * once the env has said done and the forge has been closed; rejects on a
 * bind failure or a refused register.
 */
async function serve(envUrl: string): Promise<void> {
  const forge = createApp();
  const port = await new Promise<number>((resolve, reject) => {
    forge.once('error', reject);
    forge.listen(0, () => {
      const address = forge.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge bound no TCP port to announce'));
        return;
      }
      resolve(address.port);
    });
  });
  process.stdout.write(`[main] forge is listening on port ${port}\n`);

  await announce(envUrl, port);
  process.stdout.write('[main] registered with the env; waiting for it to finish\n');

  await untilDone(envUrl);
  forge.close();
  process.stdout.write('[main] the env is done; exiting\n');
}

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[main] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

try {
  await serve(envUrl);
  process.exit(0);
} catch (err) {
  process.stderr.write(`[main] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
