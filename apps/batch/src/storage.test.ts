import { createHash } from 'node:crypto';
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { r2ClientOptions } from './storage';

const env = { R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' };

describe('R2 S3 client configuration', () => {
  it('uses the R2 endpoint and required-only SDK checksums', () => {
    const options = r2ClientOptions(env)!;
    expect(options.endpoint).toBe(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(options.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(options.responseChecksumValidation).toBe('WHEN_REQUIRED');
  });

  it('sends only Content-MD5 on PUT while preserving the required DeleteObjects checksum', async () => {
    const requests: Array<{ method: string; checksums: Record<string, string> }> = [];
    const client = new S3Client({
      ...r2ClientOptions(env),
      requestHandler: {
        async handle(request: { method: string; headers: Record<string, string> }) {
          requests.push({
            method: request.method,
            checksums: Object.fromEntries(Object.entries(request.headers).filter(([name]) => /checksum|content-md5|trailer/i.test(name)))
          });
          return { response: { statusCode: 200, headers: {}, body: Buffer.from(request.method === 'POST' ? '<DeleteResult />' : '') } };
        }
      }
    });
    const bytes = Buffer.from('forecast payload');
    const contentMd5 = createHash('md5').update(bytes).digest('base64');
    try {
      await client.send(new PutObjectCommand({ Bucket: 'test-bucket', Key: 'forecast.bin', Body: bytes, ContentMD5: contentMd5 }));
      await client.send(new DeleteObjectsCommand({ Bucket: 'test-bucket', Delete: { Objects: [{ Key: 'forecast.bin' }], Quiet: true } }));
      expect(requests).toEqual([
        { method: 'PUT', checksums: { 'content-md5': contentMd5 } },
        { method: 'POST', checksums: { 'x-amz-sdk-checksum-algorithm': 'CRC32', 'x-amz-checksum-crc32': expect.stringMatching(/^[A-Za-z0-9+/]{6}==$/) } }
      ]);
    } finally {
      client.destroy();
    }
  });

  it('requires credentials before constructing a client', () => {
    expect(() => r2ClientOptions({ ...env, R2_SECRET_ACCESS_KEY: '' })).toThrow(/R2_SECRET_ACCESS_KEY/);
  });
});
