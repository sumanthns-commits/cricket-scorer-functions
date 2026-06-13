import {createHash} from "crypto";
import {getFirestore} from "firebase-admin/firestore";

interface CacheEntry {
  keyId: string;
  clubId: string;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export async function verifyApiKey(
  rawKey: string
): Promise<{ keyId: string; clubId: string } | null> {
  const hash = hashKey(rawKey);
  const now = Date.now();

  const cached = cache.get(hash);
  if (cached && cached.expiresAt > now) {
    return {keyId: cached.keyId, clubId: cached.clubId};
  }

  const db = getFirestore();
  const snap = await db
    .collection("apiKeys")
    .where("hashedKey", "==", hash)
    .limit(1)
    .get();

  if (snap.empty) return null;

  const doc = snap.docs[0];
  const data = doc.data();
  const entry: CacheEntry = {
    keyId: doc.id,
    clubId: data.clubId,
    expiresAt: now + CACHE_TTL_MS,
  };
  cache.set(hash, entry);

  // async — intentionally not awaited
  doc.ref.update({lastUsedAt: new Date()}).catch(() => undefined);

  return {keyId: entry.keyId, clubId: entry.clubId};
}
