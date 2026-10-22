import { describe, expect, it } from 'vitest';
import { HelloScope } from './hello-mode.js';
import { ProductionTicketRequestSchema } from './production-policy.js';

const base = { workspaceId: 'ws_staff', nonce: 'nonce-1', bridgePort: 4400, scope: HelloScope.ACT };

describe('the ticket request', () => {
  // A hosted verifier runs its own bridge per site: the service must be told the origin to bind the
  // ticket to and the bridge to put in it, never guess them from the port.
  it('carries the origin the ticket is bound to and the bridge the page dials', () => {
    const request = {
      ...base,
      origin: 'https://app.example.com',
      bridge: 'ws://127.0.0.1:4400/reticle',
    };
    expect(ProductionTicketRequestSchema.parse(request)).toEqual(request);
  });

  it('still accepts a request without them, from an older daemon', () => {
    expect(ProductionTicketRequestSchema.safeParse(base).success).toBe(true);
  });

  it('refuses an origin or a bridge that is not a URL', () => {
    expect(ProductionTicketRequestSchema.safeParse({ ...base, origin: 'nope' }).success).toBe(
      false,
    );
    expect(ProductionTicketRequestSchema.safeParse({ ...base, bridge: 'nope' }).success).toBe(
      false,
    );
  });
});
