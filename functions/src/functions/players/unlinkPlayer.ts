import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { assertAdmin } from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const unlinkPlayer = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { clubId, playerId } = request.data as { clubId: string; playerId: string };
    if (!clubId || !playerId) throw new HttpsError("invalid-argument", "Missing required fields");

    await assertAdmin(uid);

    const db = getFirestore();
    const playerRef = db.collection("players").doc(playerId);
    const clubPlayerRef = db.collection("clubs").doc(clubId).collection("players").doc(playerId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(playerRef);
      if (!snap.exists) throw new HttpsError("not-found", "Player not found");

      const player = snap.data()!;
      if (player.clubId !== clubId) throw new HttpsError("permission-denied", "Player not in club");
      if (player.playerType !== "registered") {
        throw new HttpsError("failed-precondition", "Player is not registered");
      }

      const now = Timestamp.now();
      const updates = {
        playerType: "ghost",
        uid: FieldValue.delete(),
        displayName: FieldValue.delete(),
        updatedAt: now,
      };

      tx.update(playerRef, updates);
      tx.update(clubPlayerRef, updates);
    });

    return { success: true };
  }
);
