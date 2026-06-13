import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {assertClubMember} from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getClubPlayerStats = onCall(
  {region: REGION},
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const {clubId, playerId} = request.data as { clubId: string; playerId?: string };
    if (!clubId) throw new HttpsError("invalid-argument", "Missing clubId");

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const playersCol = db.collection("clubs").doc(clubId).collection("players");

    if (playerId) {
      const snap = await playersCol.doc(playerId).get();
      if (!snap.exists) throw new HttpsError("not-found", "Player not found in club");
      return {id: snap.id, ...snap.data()};
    }

    const snap = await playersCol.get();
    return snap.docs.map((doc) => ({id: doc.id, ...doc.data()}));
  }
);
