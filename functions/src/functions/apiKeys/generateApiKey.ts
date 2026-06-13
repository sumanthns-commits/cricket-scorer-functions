import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {createHash, randomBytes} from "crypto";
import {assertSuperAdmin} from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

function generateRawKey(): string {
  return "csk_" + randomBytes(32).toString("hex");
}

function hashKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

export const generateApiKey = onCall(
  {region: REGION},
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const {clubId} = request.data as { clubId: string };
    if (!clubId) throw new HttpsError("invalid-argument", "Missing clubId");

    await assertSuperAdmin(uid);

    const rawKey = generateRawKey();
    const hashedKey = hashKey(rawKey);

    const db = getFirestore();
    const now = Timestamp.now();

    await db.collection("apiKeys").add({
      clubId,
      hashedKey,
      createdBy: uid,
      createdAt: now,
    });

    // Raw key returned once — never stored
    return {key: rawKey};
  }
);
