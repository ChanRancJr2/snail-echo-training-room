import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { TextCipher } from '../src/crypto.ts';

test('sensitive text is encrypted with authenticated encryption and rejects tampering', () => {
  const cipher = new TextCipher(randomBytes(32).toString('base64'));
  const clear = '需求：午饭取决于外婆身体情况';
  const sealed = cipher.encrypt(clear);
  assert.equal(sealed.ciphertext.includes(Buffer.from(clear)), false);
  assert.equal(cipher.decrypt(sealed.ciphertext, sealed.nonce, sealed.keyRef), clear);
  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0] = (tampered[0] ?? 0) ^ 1;
  assert.throws(() => cipher.decrypt(tampered, sealed.nonce, sealed.keyRef));
});
