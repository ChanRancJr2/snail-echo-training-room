import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3AudioStorage } from '../src/audio-storage.ts';

const endpoint = process.env.S3_ENDPOINT;
const accessKey = process.env.S3_ACCESS_KEY;
const secretKey = process.env.S3_SECRET_KEY;
const bucket = process.env.S3_BUCKET ?? 'echo-private';

test('presigned upload is readable through the S3-compatible storage adapter', { skip: !endpoint || !accessKey || !secretKey }, async () => {
  const client = new S3Client({ endpoint: endpoint!, region: 'us-east-1', forcePathStyle: true,
    credentials: { accessKeyId: accessKey!, secretAccessKey: secretKey! } });
  const storage = new S3AudioStorage({ endpoint: endpoint!, region: 'us-east-1', bucket, accessKey: accessKey!, secretKey: secretKey! });
  const key = `tests/${randomUUID()}`;
  try {
    try { await client.send(new CreateBucketCommand({ Bucket: bucket })); }
    catch (error) { if (!(error instanceof Error && error.name === 'BucketAlreadyOwnedByYou')) throw error; }
    assert.equal(await storage.inspect(key), null);
    const signed = await storage.uploadUrl(key, 'audio/webm');
    const data = Buffer.from('test audio bytes');
    const response = await fetch(signed, { method: 'PUT', headers: { 'Content-Type': 'audio/webm' }, body: data });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(await storage.inspect(key), { bytes: data.byteLength, mimeType: 'audio/webm' });
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => undefined);
    client.destroy();
  }
});
