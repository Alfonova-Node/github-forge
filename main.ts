// github-forge entrypoint.
//
// Lifecycle (make.fun harness): when MAKEFUN_ENV_URL is set, the server
// binds an ephemeral port, registers it at $MAKEFUN_ENV_URL/register, then
// polls $MAKEFUN_ENV_URL/done until the trial is over and exits 0.
// When MAKEFUN_ENV_URL is unset (local testing), the server just listens on
// the port from argv[2] / PORT (default: ephemeral) and serves until killed.

import { createApp } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function run(): Promise<void> {
  const app = createApp();
  const requestedPort = Number(process.argv[2] ?? process.env.PORT ?? 0);
  const port = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 0;

  await new Promise<void>((resolve, reject) => {
    app.once('error', reject);
    app.listen(port, '127.0.0.1', () => resolve());
  });
  const address = app.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`github-forge listening on 127.0.0.1:${actualPort} (token ${process.env.MAKEFUN_SHOP_TOKEN ? 'configured' : 'unset — any bearer accepted'})`);

  // Graceful shutdown: close the listener, then exit. The harness ends a
  // trial via /done, but a signal should still stop the process cleanly.
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  if (ENV_URL === '') {
    // Standalone mode: serve until the process is stopped.
    console.log(`healthz: http://127.0.0.1:${actualPort}/healthz`);
    return;
  }

  await postJson(`${ENV_URL}/register`, { port: actualPort });
  // Poll until the harness says the trial is done.
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const done = await getJson(`${ENV_URL}/done`);
      if (done !== null && typeof done === 'object' && (done as Record<string, unknown>).done === true) {
        break;
      }
    } catch {
      // Transient harness error: keep polling.
    }
  }
  app.close();
  process.exit(0);
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
