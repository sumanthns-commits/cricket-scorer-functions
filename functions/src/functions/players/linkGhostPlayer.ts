import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { assertAdmin } from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const linkGhostPlayer = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { clubId, ghostPlayerId, playerUid, displayName } = request.data as {
      clubId: string;
      ghostPlayerId: string;
      playerUid: string;
      displayName: string;
    };

    if (!clubId || !ghostPlayerId || !playerUid || !displayName) {
      throw new HttpsError("invalid-argument", "Missing required fields");
    }

    await assertAdmin(uid);

    const db = getFirestore();
    const playerRef = db.collection("players").doc(ghostPlayerId);
    const clubPlayerRef = db.collection("clubs").doc(clubId).collection("players").doc(ghostPlayerId);

    await db.runTransaction(async (tx) => {
      // Guard: uid already linked to another player in this club
      const existingSnap = await db
        .collection("players")
        .where("clubId", "==", clubId)
        .where("uid", "==", playerUid)
        .limit(1)
        .get();
      if (!existingSnap.empty && existingSnap.docs[0].id !== ghostPlayerId) {
        throw new HttpsError("already-exists", "This user is already linked to a player in this club");
      }

      const snap = await tx.get(playerRef);
      if (!snap.exists) throw new HttpsError("not-found", "Player not found");

      const player = snap.data()!;
      if (player.clubId !== clubId) throw new HttpsError("permission-denied", "Player not in club");
      if (player.playerType === "registered") {
        throw new HttpsError("failed-precondition", "Player is already registered");
      }

      const now = Timestamp.now();
      const updates = { playerType: "registered", uid: playerUid, displayName, updatedAt: now };

      tx.update(playerRef, updates);
      tx.update(clubPlayerRef, updates);
    });

    return { success: true };
  }
);
