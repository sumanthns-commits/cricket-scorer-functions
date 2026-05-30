import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { assertClubMember } from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getBattingInsights = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { clubId, matchId } = request.data as { clubId: string; matchId: string };
    if (!clubId || !matchId) throw new HttpsError("invalid-argument", "Missing required fields");

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const snap = await db
      .collection("matches")
      .doc(matchId)
      .collection("innings")
      .get();

    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }
);
