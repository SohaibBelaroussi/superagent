import { isNotNull, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { providers, pushConfig, secrets } from '../db/schema';
import { vaultContext } from '../modules/capabilities/secrets';
import { secretContext } from '../modules/providers/registry';
import { accountContext } from '../modules/push/fcm';
import type { SecretBox } from './secret-box';

/**
 * Whether SUPERAGENT_ENCRYPTION_KEY opens what this database keeps sealed: `ok`, `mismatch`, or
 * `empty` (nothing sealed yet: any key will do). A restored backup with another key would lose every
 * provider key and secret, and the push service account, so this is checked at boot and reported by
 * /ready and the attention inbox.
 */
export type KeyCheck = 'ok' | 'mismatch' | 'empty';

/** Opens one sealed value of each kind: a provider's key or headers, a vault secret, the push account. */
export async function checkEncryptionKey(db: Db, box: SecretBox): Promise<KeyCheck> {
  const [provider] = await db
    .select()
    .from(providers)
    .where(or(isNotNull(providers.apiKeyEnc), isNotNull(providers.headersEnc)))
    .limit(1);
  const [secret] = await db.select().from(secrets).limit(1);
  const [push] = await db.select().from(pushConfig).limit(1);
  if (!provider && !secret && !push) return 'empty';
  try {
    if (provider?.apiKeyEnc)
      box.open(provider.apiKeyEnc, secretContext(provider.id, 'api_key', provider.baseUrl));
    else if (provider?.headersEnc)
      box.open(provider.headersEnc, secretContext(provider.id, 'headers', provider.baseUrl));
    if (secret) box.open(secret.valueEnc, vaultContext(secret.id));
    if (push) box.open(push.serviceAccountEnc, accountContext);
    return 'ok';
  } catch {
    return 'mismatch';
  }
}
