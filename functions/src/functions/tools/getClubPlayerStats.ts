import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {assertClubMember} from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";
const MAX_PLAYERS = 30;
const FORM_MATCHES = 5;

export const getClubPlayerStats = onCall(
  {region: REGION, invoker: "public"},
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const {clubId, matchId} = request.data as { clubId: string; matchId?: string };
    if (!clubId) throw new HttpsError("invalid-argument", "Missing clubId");

    await assertClubMember(uid, clubId);

    const db = getFirestore();

    // Optionally restrict to a match's squad
    let squadIds: Set<string> | null = null;
    if (matchId) {
      const matchSnap = await db
        .collection("clubs").doc(clubId)
        .collection("matches").doc(matchId)
        .get();
      const squad = matchSnap.data()?.squad as string[] | undefined;
      if (squad) squadIds = new Set(squad);
    }

    const snap = await db.collection("clubs").doc(clubId).collection("players").get();

    const players = snap.docs
      .filter((d) => d.data().type !== "linked")
      .filter((d) => !squadIds || squadIds.has(d.id))
      .slice(0, MAX_PLAYERS);

    // Fetch recent form for all players in parallel server-side — far faster
    // than N separate client→AI→Cloud Function round trips.
    const formSnaps = await Promise.all(
      players.map((p) =>
        db.collection("playerPerformances")
          .where("clubId", "==", clubId)
          .where("playerId", "==", p.id)
          .orderBy("createdAt", "desc")
          .limit(FORM_MATCHES)
          .get()
      )
    );

    return players.map((p, i) => ({
      id: p.id,
      displayName: p.data().displayName,
      battingHand: p.data().battingHand,
      bowlingStyle: p.data().bowlingStyle,
      wicketKeeping: p.data().wicketKeeping,
      skillRating: p.data().skillRating,
      strengthOverride: p.data().strengthOverride,
      careerStats: p.data().careerStats,
      recentForm: formSnaps[i].docs.map((d) => d.data()),
    }));
  }
);
