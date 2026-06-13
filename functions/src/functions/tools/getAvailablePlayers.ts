import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {assertClubMember} from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getAvailablePlayers = onCall(
  {region: REGION},
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const {clubId, matchId} = request.data as { clubId: string; matchId?: string };
    if (!clubId) throw new HttpsError("invalid-argument", "Missing clubId");

    await assertClubMember(uid, clubId);

    const db = getFirestore();

    let squadIds: Set<string> | null = null;
    if (matchId) {
      const matchSnap = await db
        .collection("clubs")
        .doc(clubId)
        .collection("matches")
        .doc(matchId)
        .get();
      const squad = matchSnap.data()?.squad as string[] | undefined;
      if (squad) squadIds = new Set(squad);
    }

    const snap = await db
      .collection("clubs")
      .doc(clubId)
      .collection("players")
      .get();

    // Exclude linked ghosts — they've been absorbed into a registered member,
    // so surfacing them would let the AI pick the same person twice.
    // When a matchId is provided, restrict to that match's squad.
    return snap.docs
      .filter((d) => d.data().type !== "linked")
      .filter((d) => !squadIds || squadIds.has(d.id))
      .map((d) => ({id: d.id, ...d.data()}));
  }
);
