import { isNotNull, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { providers, secrets } from '../db/schema';
import { vaultContext } from '../modules/capabilities/secrets';
import { secretContext } from '../modules/providers/registry';
import type { SecretBox } from './secret-box';

/**
 * Whether SUPERAGENT_ENCRYPTION_KEY opens what this database keeps sealed: `ok`, `mismatch`, or
 * `empty` (nothing sealed yet: any key will do). A restored backup with another key would lose every
 * provider key and secret, so this is checked at boot and reported by /ready and the attention inbox.
 */
export type KeyCheck = 'ok' | 'mismatch' | 'empty';

/** Opens one sealed value of each kind: a provider's key or headers, and a vault secret. */
export async function checkEncryptionKey(db: Db, box: SecretBox): Promise<KeyCheck> {
  const [provider] = await db
    .select()
    .from(providers)
    .where(or(isNotNull(providers.apiKeyEnc), isNotNull(providers.headersEnc)))
    .limit(1);
  const [secret] = await db.select().from(secrets).limit(1);
  if (!provider && !secret) return 'empty';
  try {
    if (provider?.apiKeyEnc)
      box.open(provider.apiKeyEnc, secretContext(provider.id, 'api_key', provider.baseUrl));
    else if (provider?.headersEnc)
      box.open(provider.headersEnc, secretContext(provider.id, 'headers', provider.baseUrl));
    if (secret) box.open(secret.valueEnc, vaultContext(secret.id));
    return 'ok';
  } catch {
    return 'mismatch';
  }
}
