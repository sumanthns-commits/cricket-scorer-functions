import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { assertClubMember } from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getBowlingInsights = onCall(
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

    // No separate insights store yet — surface the player's career stats so the
    // model has bowling data to reason over (returns {} if the player is gone).
    return snap.exists ? { id: snap.id, ...snap.data() } : {};
  }
);
