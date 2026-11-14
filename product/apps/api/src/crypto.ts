import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export class TextCipher {
  private readonly key: Buffer;
  readonly keyRef: string;
  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('ENCRYPTION_MASTER_KEY must decode to 32 bytes');
    this.key = key;
    const digest = createHash('sha256').update(key).digest('hex').slice(0, 32);
    this.keyRef = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
  }
  encrypt(value: string): { ciphertext: Buffer; nonce: Buffer; keyRef: string } {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext, nonce, keyRef: this.keyRef };
  }
  decrypt(ciphertext: Buffer, nonce: Buffer, keyRef: string): string {
    if (keyRef !== this.keyRef || ciphertext.length < 16) throw new Error('Encrypted data key unavailable');
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]).toString('utf8');
  }
}
