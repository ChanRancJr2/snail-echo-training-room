import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export interface AudioStorage {
  prefix(key: string): Promise<Buffer>;
  uploadUrl(key: string, mimeType: string): Promise<string>;
  downloadUrl(key: string, expiresIn?: number): Promise<string>;
  inspect(key: string): Promise<{ bytes: number; mimeType: string } | null>;
}

export class S3AudioStorage implements AudioStorage {
  private readonly client: S3Client;
  private readonly signer: S3Client;
  private readonly bucket: string;
  constructor(input: { endpoint: string; publicEndpoint?: string | undefined; region: string; bucket: string; accessKey: string; secretKey: string }) {
    this.bucket = input.bucket;
    const options = { region: input.region, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      credentials: { accessKeyId: input.accessKey, secretAccessKey: input.secretKey } };
    this.client = new S3Client({ ...options, endpoint: input.endpoint });
    this.signer = input.publicEndpoint ? new S3Client({ ...options, endpoint: input.publicEndpoint }) : this.client;
  }
  async uploadUrl(key: string, mimeType: string): Promise<string> {
    return getSignedUrl(this.signer, new PutObjectCommand({ Bucket: this.bucket, Key: key, ContentType: mimeType }), { expiresIn: 300 });
  }
  async downloadUrl(key: string, expiresIn = 60): Promise<string> {
    return getSignedUrl(this.signer, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn });
  }
  async inspect(key: string): Promise<{ bytes: number; mimeType: string } | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { bytes: result.ContentLength ?? -1, mimeType: result.ContentType ?? '' };
    } catch (error) {
      if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) return null;
      throw error;
    }
  }
  async read(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!result.Body || (result.ContentLength ?? 0) > 15_000_000) throw new Error('AUDIO_READ_FAILED');
    const bytes = await result.Body.transformToByteArray();
    if (bytes.length > 15_000_000) throw new Error('AUDIO_READ_FAILED');
    return Buffer.from(bytes);
  }
  async prefix(key: string): Promise<Buffer> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: 'bytes=0-15' }));
    if (!result.Body) return Buffer.alloc(0);
    return Buffer.from(await result.Body.transformToByteArray());
  }
  async write(key: string, bytes: Buffer, mimeType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mimeType }));
  }
  async remove(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
