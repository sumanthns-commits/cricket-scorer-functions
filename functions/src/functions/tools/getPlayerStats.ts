import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { assertClubMember } from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getPlayerStats = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { clubId, playerId } = request.data as { clubId: string; playerId: string };
    if (!clubId || !playerId) throw new HttpsError("invalid-argument", "Missing required fields");

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const snap = await db
      .collection("clubs")
      .doc(clubId)
      .collection("players")
      .doc(playerId)
      .get();
    if (!snap.exists) throw new HttpsError("not-found", "Player not found");

    return { id: snap.id, ...snap.data() };
  }
);
