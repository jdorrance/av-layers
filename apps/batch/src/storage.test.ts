import { describe, expect, it } from 'vitest';
import { r2ClientOptions } from './storage';

const env = { R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' };

describe('R2 S3 client configuration', () => {
  it('uses only the explicit Content-MD5 checksum instead of an automatic SDK checksum', () => {
    const options = r2ClientOptions(env)!;
    expect(options.endpoint).toBe(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(options.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(options.responseChecksumValidation).toBe('WHEN_REQUIRED');
  });

  it('requires credentials before constructing a client', () => {
    expect(() => r2ClientOptions({ ...env, R2_SECRET_ACCESS_KEY: '' })).toThrow(/R2_SECRET_ACCESS_KEY/);
  });
});
