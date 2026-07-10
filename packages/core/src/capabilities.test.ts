import { describe, expect, it } from 'vitest';
import { CapabilitiesSchema, RiskSurface } from './index.js';

/** Governance is additive — a manifest without it must still parse (back-compat), and a manifest with
 *  it must validate the declared risk surfaces against the shared vocabulary. */
const bare = { testids: ['pay'], signals: ['order:saved'], stores: ['cart'], flows: [] };

describe('CapabilitiesSchema governance (manifest extension)', () => {
  it('parses a manifest with no governance (back-compat)', () => {
    const parsed = CapabilitiesSchema.safeParse(bare);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.governance).toBeUndefined();
  });

  it('parses a manifest with owner/safety/scope/redact/risk', () => {
    const parsed = CapabilitiesSchema.safeParse({
      ...bare,
      governance: {
        owner: 'payments@acme.com',
        safety: ['never touches the production database'],
        scope: ['app.acme.com'],
        redact: ['cart.paymentToken'],
        risk: [{ surface: RiskSurface.PAYMENT, paths: ['src/checkout/**'], note: 'PCI surface' }],
      },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.governance?.owner).toBe('payments@acme.com');
      expect(parsed.data.governance?.risk?.[0]?.surface).toBe(RiskSurface.PAYMENT);
    }
  });

  it('rejects a risk zone with an unknown surface', () => {
    const parsed = CapabilitiesSchema.safeParse({
      ...bare,
      governance: { risk: [{ surface: 'quantum' }] },
    });
    expect(parsed.success).toBe(false);
  });
});
