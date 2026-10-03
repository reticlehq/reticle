import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRedactionPolicy,
  resetActiveRedactionPolicy,
  setActiveRedactionPolicy,
} from '@reticlehq/core';
import { projectBody } from './network-body.js';

afterEach(resetActiveRedactionPolicy);

describe('captured body redaction before retention', () => {
  it('masks built-in keys and needs app-specific keys for an unfamiliar credential name', () => {
    const body = JSON.stringify({
      apiKey: 'test-api-value-123',
      vendorPaymentToken: 'test-vendor-value-456',
      orderId: 'order-789',
    });

    const defaultBody = JSON.parse(projectBody(body, 'application/json').body) as Record<
      string,
      string
    >;
    expect(defaultBody).toEqual({
      apiKey: '[REDACTED]',
      vendorPaymentToken: 'test-vendor-value-456',
      orderId: 'order-789',
    });

    setActiveRedactionPolicy(buildRedactionPolicy({ keys: ['vendorPaymentToken'] }));
    const configuredBody = JSON.parse(projectBody(body, 'application/json').body) as Record<
      string,
      string
    >;
    expect(configuredBody).toEqual({
      apiKey: '[REDACTED]',
      vendorPaymentToken: '[REDACTED]',
      orderId: 'order-789',
    });
  });
});
