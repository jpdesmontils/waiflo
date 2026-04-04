import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);
const ALGORITHM_V2 = 'aes-256-gcm';
const ALGORITHM_V1 = 'aes-256-cbc';
const ENC_VERSION = 'v2';

async function getKey() {
  const secret = process.env.MASTER_SECRET;
  if (!secret) throw new Error('MASTER_SECRET not set in environment');
  return scryptAsync(secret, 'waiflo-salt', 32);
}

export async function encrypt(plaintext) {
  const iv  = randomBytes(12);
  const key = await getKey();
  const cipher = createCipheriv(ALGORITHM_V2, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_VERSION}:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export async function decrypt(ciphertext) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    throw new Error('Invalid ciphertext format');
  }

  const parts = ciphertext.split(':');
  const key = await getKey();

  // v2 format: v2:<ivHex>:<tagHex>:<encHex>
  if (parts[0] === ENC_VERSION && parts.length === 4) {
    const [, ivHex, tagHex, encHex] = parts;
    const decipher = createDecipheriv(ALGORITHM_V2, key, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  }

  // Legacy v1 backward compatibility: <ivHex>:<encHex>
  if (parts.length === 2) {
    const [ivHex, encHex] = parts;
    const decipher = createDecipheriv(ALGORITHM_V1, key, Buffer.from(ivHex, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encHex, 'hex')),
      decipher.final()
    ]);
    return decrypted.toString('utf8');
  }

  throw new Error('Unsupported ciphertext format');
}
