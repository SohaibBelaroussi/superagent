import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const FORMAT_VERSION = 'v1';
const TAG_BYTES = 16;

/**
 * Encrypts secrets at rest (provider API keys, headers) with AES-256-GCM.
 * Output: `v1.<iv>.<tag>.<ciphertext>` (base64url). The context string (e.g. `provider:<id>:api_key`)
 * is authenticated, so a sealed value copied to another row or field fails to open.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(keyBase64: string) {
    const key = Buffer.from(keyBase64, 'base64');
    if (key.length !== 32) throw new Error('Encryption key must decode to 32 bytes');
    this.key = key;
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [FORMAT_VERSION, iv, cipher.getAuthTag(), ciphertext]
      .map((part) => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  open(sealed: string, context: string): string {
    const [version, iv, tag, ciphertext] = sealed.split('.');
    if (version !== FORMAT_VERSION || !iv || !tag || ciphertext === undefined) {
      throw new Error('Unsupported sealed secret format');
    }
    const authTag = Buffer.from(tag, 'base64url');
    // Without a fixed length GCM accepts truncated tags (down to 4 bytes), which weakens forgery resistance.
    if (authTag.length !== TAG_BYTES) throw new Error('Invalid authentication tag');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString(
      'utf8',
    );
  }
}
