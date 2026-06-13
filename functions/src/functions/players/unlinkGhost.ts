import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import type {CareerStats} from "../../types/index.js";
import {subtractCareerStats} from "../../utils/mergeCareerStats.js";

const REGION = "australia-southeast1";

/**
 * Reverses a ghost→member link made at join-approval. Per-club admin only.
 * Subtracts the linked ghost's frozen career stats back out of the member's
 * per-club stats and restores the ghost to type:'ghost' (so it reappears in
 * selection). highScore can't be perfectly un-maxed without rescanning matches,
 * so it's left as-is — an accepted approximation.
 */
export const unlinkGhost = onCall({region: REGION}, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError("unauthenticated", "Must be signed in");

  const {clubId, memberUid} = request.data as { clubId: string; memberUid: string };
  if (!clubId || !memberUid) throw new HttpsError("invalid-argument", "Missing fields");

  const db = getFirestore();

  // Per-club admin check (NOT the global customClaims.admin).
  const callerSnap = await db
    .collection("clubs").doc(clubId).collection("players").doc(callerUid)
    .get();
  if (callerSnap.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const memberRef = db.collection("clubs").doc(clubId).collection("players").doc(memberUid);

  await db.runTransaction(async (tx) => {
    const memberSnap = await tx.get(memberRef);
    const member = memberSnap.data();
    const linkedGhost = member?.linkedGhost as { ghostId: string } | undefined;
    if (!member || !linkedGhost?.ghostId) {
      throw new HttpsError("failed-precondition", "No linked ghost to unlink");
    }

    const ghostRef = db.collection("clubs").doc(clubId).collection("players").doc(linkedGhost.ghostId);
    const ghostSnap = await tx.get(ghostRef);
    const ghost = ghostSnap.data();
    const ghostStats = (ghost?.careerStats as CareerStats) ?? null;

    const memberStats = member.careerStats as CareerStats;
    const restored = ghostStats ? subtractCareerStats(memberStats, ghostStats) : memberStats;

    tx.update(memberRef, {careerStats: restored, linkedGhost: FieldValue.delete()});
    if (ghostSnap.exists) {
      tx.update(ghostRef, {type: "ghost", linkedTo: FieldValue.delete(), linkedAt: FieldValue.delete()});
    }
  });

  return {success: true};
});
