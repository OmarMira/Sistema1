import { db } from '@/lib/db';
import { decrypt, encrypt } from '@/lib/crypto';
import { AI_CONFIG } from '@/lib/constants/ai-config';
import { logger } from '@/lib/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AiConfig {
  apiKey: string;
  model: string;
  baseUrl: string;
}

// ─── In-memory cache ─────────────────────────────────────────────────────────
// TTL: 5 minutes. Cleared explicitly after writes (POST).

const CACHE_TTL_MS = 5 * 60 * 1000;

let _cached: AiConfig | null = null;
let _cachedAt = 0;

export function clearAiConfigCache(): void {
  _cached = null;
  _cachedAt = 0;
}

// ─── DB keys ─────────────────────────────────────────────────────────────────

const KEY_ENCRYPTED_KEY = 'ai_encrypted_key';
const KEY_MODEL = 'ai_model';
const KEY_BASE_URL = 'ai_base_url';

async function getDbValue(key: string): Promise<string | null> {
  const row = await db.systemConfig.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function setDbValue(key: string, value: string): Promise<void> {
  await db.systemConfig.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Read AI configuration: DB-first with in-memory cache, fallback to process.env.
 *
 * Migration helper: if no DB record exists but env has a value, it is
 * automatically seeded into the DB for future reads.
 */
export async function getAiConfig(): Promise<AiConfig> {
  // Cache hit?
  const now = Date.now();
  if (_cached && now - _cachedAt < CACHE_TTL_MS) {
    logger.info('[AI CONFIG] Cache hit');
    return _cached;
  }

  // Read from DB
  const [encryptedKey, model, baseUrl] = await Promise.all([
    getDbValue(KEY_ENCRYPTED_KEY),
    getDbValue(KEY_MODEL),
    getDbValue(KEY_BASE_URL),
  ]);

  logger.info('[AI CONFIG] DB read', {
    hasEncryptedKey: !!encryptedKey,
    hasModel: !!model,
    hasBaseUrl: !!baseUrl,
    encryptedKeyLen: encryptedKey?.length,
  });

  // If all three are in DB, decrypt and cache
  if (encryptedKey && model && baseUrl) {
    try {
      const apiKey = decrypt(encryptedKey);
      _cached = { apiKey, model, baseUrl };
      _cachedAt = now;
      logger.info('[AI CONFIG] Decrypted OK', { model, baseUrl, keyPrefix: apiKey.slice(0, 6) });
      return _cached;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error('[AI CONFIG] Failed to decrypt stored key', { error: errMsg });
      throw new Error(
        'Could not decrypt the stored AI API key. ' +
        'This may have been encrypted with a different SESSION_SECRET, or the data may be corrupted. ' +
        'Re-save your AI configuration via /api/config/ai to re-encrypt with the current SESSION_SECRET.',
      );
    }
  }

  // ─── Fallback: process.env (backward compat + migration seed) ──────────
  const envApiKey = process.env.AI_API_KEY;
  const envModel = process.env.AI_MODEL || AI_CONFIG.DEFAULT_MODEL;
  const envBaseUrl = process.env.AI_BASE_URL || AI_CONFIG.BASE_URL;

  logger.info('[AI CONFIG] Env fallback', { hasEnvApiKey: !!envApiKey });

  if (envApiKey) {
    // Seed DB so future reads don't depend on env
    try {
      const reEncrypted = encrypt(envApiKey);
      await Promise.all([
        setDbValue(KEY_ENCRYPTED_KEY, reEncrypted),
        setDbValue(KEY_MODEL, envModel),
        setDbValue(KEY_BASE_URL, envBaseUrl),
      ]);
    } catch (err) {
      logger.warn('[AI CONFIG] Failed to seed DB from env', { error: String(err) });
    }

    _cached = { apiKey: envApiKey, model: envModel, baseUrl: envBaseUrl };
    _cachedAt = now;
    return _cached;
  }

  logger.error('[AI CONFIG] No config found — neither DB nor env');
  throw new Error(
    'AI configuration missing. Set AI_API_KEY in .env or save via /api/config/ai.',
  );
}

/**
 * Persist AI configuration to DB and invalidate the in-memory cache.
 * Does NOT mutate process.env — the caller is responsible for that if needed.
 */
export async function setAiConfig(config: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): Promise<void> {
  const encryptedKey = encrypt(config.apiKey);
  const model = config.model || AI_CONFIG.DEFAULT_MODEL;
  const baseUrl = config.baseUrl || AI_CONFIG.BASE_URL;

  await Promise.all([
    setDbValue(KEY_ENCRYPTED_KEY, encryptedKey),
    setDbValue(KEY_MODEL, model),
    setDbValue(KEY_BASE_URL, baseUrl),
  ]);

  clearAiConfigCache();
}
