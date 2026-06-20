import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import type {CareerStats} from "../../types/index.js";
import {addCareerStats} from "../../utils/mergeCareerStats.js";

const REGION = "australia-southeast1";

const emptyStats: CareerStats = {
  totalRuns: 0,
  totalWickets: 0,
  totalBallsFaced: 0,
  totalDismissals: 0,
  totalBallsBowled: 0,
  totalRunsConceded: 0,
  totalCatches: 0,
  totalRunOuts: 0,
  totalStumpings: 0,
  highScore: 0,
  matchesPlayed: 0,
};

/**
 * Links an existing ghost player into a registered member without requiring a
 * join request. Per-club admin only. Merges the ghost's career stats into the
 * member's per-club stats, marks the ghost as type:'linked', and re-keys any
 * historical playerPerformances so form charts remain continuous.
 */
export const linkGhost = onCall({region: REGION, invoker: "public"}, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError("unauthenticated", "Must be signed in");

  const {clubId, memberUid, ghostId} = request.data as {
    clubId: string;
    memberUid: string;
    ghostId: string;
  };

  if (!clubId || !memberUid || !ghostId) {
    throw new HttpsError("invalid-argument", "clubId, memberUid, and ghostId are required");
  }

  const db = getFirestore();

  const callerSnap = await db
    .collection("clubs").doc(clubId).collection("players").doc(callerUid)
    .get();
  if (callerSnap.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const memberRef = db.collection("clubs").doc(clubId).collection("players").doc(memberUid);
  const ghostRef = db.collection("clubs").doc(clubId).collection("players").doc(ghostId);

  await db.runTransaction(async (tx) => {
    const [memberSnap, ghostSnap] = await Promise.all([tx.get(memberRef), tx.get(ghostRef)]);

    const member = memberSnap.data();
    if (!memberSnap.exists || member?.type !== "registered") {
      throw new HttpsError("failed-precondition", "Target must be a registered player");
    }
    if (member?.linkedGhost) {
      throw new HttpsError("failed-precondition", "Player already has a linked ghost — unlink first");
    }

    const ghost = ghostSnap.data();
    if (!ghostSnap.exists || ghost?.type !== "ghost") {
      throw new HttpsError("failed-precondition", "Ghost player not available to link");
    }

    const now = Timestamp.now();
    const ghostStats = (ghost.careerStats as CareerStats) ?? emptyStats;
    const memberStats = (member.careerStats as CareerStats) ?? emptyStats;
    const mergedStats = addCareerStats(memberStats, ghostStats);

    tx.update(memberRef, {
      careerStats: mergedStats,
      linkedGhost: {ghostId, displayName: ghost.displayName as string, linkedAt: now},
    });
    tx.update(ghostRef, {type: "linked", linkedTo: memberUid, linkedAt: now});
  });

  // Best-effort: re-key ghost's playerPerformances to the member so form charts stay continuous.
  try {
    const perfs = await db
      .collection("playerPerformances")
      .where("clubId", "==", clubId)
      .where("playerId", "==", ghostId)
      .get();
    if (!perfs.empty) {
      const batch = db.batch();
      for (const p of perfs.docs) {
        batch.set(
          db.collection("playerPerformances").doc(`${p.data().matchId}_${memberUid}`),
          {...p.data(), playerId: memberUid},
        );
        batch.delete(p.ref);
      }
      await batch.commit();
    }
  } catch {
    // form-chart continuity is best-effort
  }

  return {success: true};
});
