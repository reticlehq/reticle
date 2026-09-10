import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE } from '@reticlehq/core';
import { redactUrl } from './network-redact.js';

describe('redactUrl — presigned cloud storage URLs', () => {
  const S3_URL =
    'https://my-bucket.s3.amazonaws.com/object.pdf' +
    '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
    '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
    '&X-Amz-Date=20130524T000000Z' +
    '&X-Amz-Expires=86400' +
    '&X-Amz-SignedHeaders=host' +
    '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404';

  const GCS_URL =
    'https://storage.googleapis.com/my-bucket/object.pdf' +
    '?X-Goog-Algorithm=GOOG4-RSA-SHA256' +
    '&X-Goog-Credential=service%40project.iam.gserviceaccount.com%2F20220101%2Fauto%2Fstorage%2Fgoog4_request' +
    '&X-Goog-Date=20220101T000000Z' +
    '&X-Goog-Expires=900' +
    '&X-Goog-Signature=abc123def456';

  it('redacts X-Amz-Credential and X-Amz-Signature from a presigned S3 URL', () => {
    const result = redactUrl(S3_URL);
    const encoded = encodeURIComponent(REDACTED_VALUE);
    expect(result).toContain(`X-Amz-Credential=${encoded}`);
    expect(result).toContain(`X-Amz-Signature=${encoded}`);
  });

  it('preserves non-secret AWS parameters (Algorithm, Date, Expires, SignedHeaders)', () => {
    const result = redactUrl(S3_URL);
    expect(result).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(result).toContain('X-Amz-Date=20130524T000000Z');
    expect(result).toContain('X-Amz-Expires=86400');
    expect(result).toContain('X-Amz-SignedHeaders=host');
  });

  it('redacts X-Goog-Credential and X-Goog-Signature from a presigned GCS URL', () => {
    const result = redactUrl(GCS_URL);
    const encoded = encodeURIComponent(REDACTED_VALUE);
    expect(result).toContain(`X-Goog-Credential=${encoded}`);
    expect(result).toContain(`X-Goog-Signature=${encoded}`);
  });

  it('preserves non-secret GCS parameters (Algorithm, Date, Expires)', () => {
    const result = redactUrl(GCS_URL);
    expect(result).toContain('X-Goog-Algorithm=GOOG4-RSA-SHA256');
    expect(result).toContain('X-Goog-Date=20220101T000000Z');
    expect(result).toContain('X-Goog-Expires=900');
  });

  it('preserves the URL path and host', () => {
    const result = redactUrl(S3_URL);
    expect(result).toContain('https://my-bucket.s3.amazonaws.com/object.pdf');
  });
});
