import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Refuse occupied ports without terminating a developer's daemon or connected clients. */
export default async function setup(): Promise<void> {
  const ports = [Number(process.env['RETICLE_INTEGRATION_PORT'] ?? 15400), 5301, 5302, 5303, 5304];
  for (const port of ports) {
    await new Promise<void>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', (error) =>
        reject(
          new Error(`Integration port ${port} is occupied; its owner was left running.`, {
            cause: error,
          }),
        ),
      );
      probe.listen(port, () => probe.close((error) => (error ? reject(error) : resolve())));
    });
  }
  const state = mkdtempSync(join(tmpdir(), 'reticle-integration-'));
  process.env['RETICLE_STATE_DIR'] = state;
  process.env['RETICLE_PAIRING_TOKEN_DIR'] = state;
}
