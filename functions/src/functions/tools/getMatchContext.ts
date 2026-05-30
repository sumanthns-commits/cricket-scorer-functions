import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { assertClubMember } from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getMatchContext = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { clubId, matchId } = request.data as { clubId: string; matchId: string };
    if (!clubId || !matchId) throw new HttpsError("invalid-argument", "Missing required fields");

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const matchSnap = await db.collection("matches").doc(matchId).get();
    if (!matchSnap.exists) throw new HttpsError("not-found", "Match not found");

    const match = matchSnap.data()!;
    if (match.clubId !== clubId) throw new HttpsError("permission-denied", "Match not in club");

    return { id: matchSnap.id, ...match };
  }
);
