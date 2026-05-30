import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { assertClubMember } from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getPlayerForm = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { clubId, playerId, lastN = 5 } = request.data as {
      clubId: string;
      playerId: string;
      lastN?: number;
    };
    if (!clubId || !playerId) throw new HttpsError("invalid-argument", "Missing required fields");

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const snap = await db
      .collection("playerPerformances")
      .where("clubId", "==", clubId)
      .where("playerId", "==", playerId)
      .orderBy("createdAt", "desc")
      .limit(lastN)
      .get();

    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
);
