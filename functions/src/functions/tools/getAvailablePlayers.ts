import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { assertClubMember } from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getAvailablePlayers = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { clubId } = request.data as { clubId: string };
    if (!clubId) throw new HttpsError("invalid-argument", "Missing clubId");

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const snap = await db
      .collection("players")
      .where("clubId", "==", clubId)
      .where("playerType", "==", "registered")
      .get();

    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
);
