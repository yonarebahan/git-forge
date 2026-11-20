import { createApp } from './app.ts';

const environment = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const backoff = (attempt: number) => Math.min(2000, 250 * 2 ** Math.min(attempt, 8));

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = await fetch(`${environment}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }), signal: AbortSignal.timeout(30_000),
      });
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        throw new Error(`Invalid registration: HTTP ${reply.status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Invalid registration:')) throw error;
    }
    await delay(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP listener');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  // Development keeps the same ephemeral listener, without a suite lifecycle.
  if (!environment) return;
  await register(address.port);
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = await fetch(`${environment}/done`, { signal: AbortSignal.timeout(30_000) });
      if (reply.ok && (await reply.json() as { done?: boolean }).done === true) break;
    } catch { /* A failed poll is not completion. */ }
    await delay(backoff(attempt));
  }
  server.close();
  server.closeAllConnections();
  process.exit(0);
}
main().catch(error => { process.stderr.write(`${error}\n`); process.exit(1); });
