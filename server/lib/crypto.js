import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);
const ALGORITHM   = 'aes-256-cbc';

async function getKey() {
  const secret = process.env.MASTER_SECRET;
  if (!secret) throw new Error('MASTER_SECRET not set in environment');
  return scryptAsync(secret, 'waiflo-salt', 32);
}

export async function encrypt(plaintext) {
  const iv  = randomBytes(16);
  const key = await getKey();
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

export async function decrypt(ciphertext) {
  const [ivHex, encHex] = ciphertext.split(':');
  const key = await getKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encHex, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}
