import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore, FieldValue, Timestamp} from "firebase-admin/firestore";
import type {CareerStats} from "../../types/index.js";
import {addCareerStats} from "../../utils/mergeCareerStats.js";

const REGION = "australia-southeast1";

// Mirrors the shape seeded by clubService.createClub for a new player.
const emptyStats = {
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

type Decision = "approve" | "reject";

/**
 * Approves or rejects a club join request. Authorised by PER-CLUB admin role
 * (clubs/{clubId}/players/{caller}.role === 'admin') — NOT the global
 * customClaims.admin used by assertAdmin. On approval, creates the registered
 * player doc and adds the club to the requester's membership index (both writes
 * the client cannot make itself, hence this runs under the Admin SDK).
 */
export const resolveJoinRequest = onCall({region: REGION}, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError("unauthenticated", "Must be signed in");

  const {clubId, requesterUid, decision, linkGhostId} = request.data as {
    clubId: string;
    requesterUid: string;
    decision: Decision;
    // Optional: an existing ghost player in this club to absorb into the new
    // member (its career stats merge into the member's per-club stats).
    linkGhostId?: string;
  };

  if (!clubId || !requesterUid || (decision !== "approve" && decision !== "reject")) {
    throw new HttpsError("invalid-argument", "Missing or invalid fields");
  }

  const db = getFirestore();

  // Per-club admin check.
  const callerPlayerSnap = await db
    .collection("clubs").doc(clubId).collection("players").doc(callerUid)
    .get();
  if (callerPlayerSnap.data()?.role !== "admin") {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const requestRef = db
    .collection("clubs").doc(clubId).collection("joinRequests").doc(requesterUid);
  const playerRef = db
    .collection("clubs").doc(clubId).collection("players").doc(requesterUid);
  const membershipRef = db.collection("userMemberships").doc(requesterUid);
  const userRef = db.collection("users").doc(requesterUid);

  await db.runTransaction(async (tx) => {
    const reqSnap = await tx.get(requestRef);
    if (!reqSnap.exists) throw new HttpsError("not-found", "Join request not found");
    if (reqSnap.data()?.status !== "pending") {
      throw new HttpsError("failed-precondition", "Request already resolved");
    }

    const now = Timestamp.now();

    if (decision === "reject") {
      tx.update(requestRef, {status: "rejected", resolvedAt: now, resolvedBy: callerUid});
      return;
    }

    // approve
    const reqData = reqSnap.data() ?? {};
    const userSnap = await tx.get(userRef);
    const user = userSnap.data() ?? {};
    const displayName = (user.displayName as string) || (reqData.displayName as string) || "";
    const email = (user.email as string) ?? null;
    const photoURL = (user.photoURL as string) ?? (reqData.photoURL as string) ?? null;

    const existingPlayer = await tx.get(playerRef);

    // Optional ghost link: validate and prepare the per-club stats merge. ALL
    // reads must precede writes in a transaction, so read the ghost here.
    const ghostRef = linkGhostId ?
      db.collection("clubs").doc(clubId).collection("players").doc(linkGhostId) :
      null;
    let ghostStats: CareerStats | null = null;
    let ghostName = "";
    if (ghostRef) {
      const ghostSnap = await tx.get(ghostRef);
      const ghost = ghostSnap.data();
      if (!ghostSnap.exists || ghost?.type !== "ghost") {
        throw new HttpsError("failed-precondition", "Ghost player not available to link");
      }
      ghostStats = (ghost.careerStats as CareerStats) ?? emptyStats;
      ghostName = (ghost.displayName as string) ?? "";
    }

    const baseStats = (existingPlayer.data()?.careerStats as CareerStats) ?? emptyStats;
    const mergedStats = ghostStats ? addCareerStats(baseStats, ghostStats) : baseStats;
    const linkedGhost = ghostRef ?
      {ghostId: linkGhostId, displayName: ghostName, linkedAt: now} :
      null;

    if (!existingPlayer.exists) {
      tx.set(playerRef, {
        id: requesterUid,
        clubId,
        playerId: requesterUid,
        role: "member",
        joinedAt: now,
        displayName,
        email,
        photoURL,
        type: "registered",
        activeClaim: null,
        careerStats: mergedStats,
        ...(linkedGhost ? {linkedGhost} : {}),
      });
    } else if (linkedGhost) {
      tx.update(playerRef, {careerStats: mergedStats, linkedGhost});
    }

    if (ghostRef && linkedGhost) {
      tx.update(ghostRef, {type: "linked", linkedTo: requesterUid, linkedAt: now});
    }

    tx.set(membershipRef, {clubIds: FieldValue.arrayUnion(clubId)}, {merge: true});
    tx.update(requestRef, {status: "approved", resolvedAt: now, resolvedBy: callerUid});
  });

  // Best-effort (post-commit, non-transactional): re-key the linked ghost's
  // per-match performance rows to the member so their "last 5" form chart stays
  // continuous. Safe to skip on failure — career totals already merged above.
  if (decision === "approve" && linkGhostId) {
    try {
      const perfs = await db
        .collection("playerPerformances")
        .where("clubId", "==", clubId)
        .where("playerId", "==", linkGhostId)
        .get();
      if (!perfs.empty) {
        const batch = db.batch();
        for (const p of perfs.docs) {
          batch.set(
            db.collection("playerPerformances").doc(`${p.data().matchId}_${requesterUid}`),
            {...p.data(), playerId: requesterUid},
          );
          batch.delete(p.ref);
        }
        await batch.commit();
      }
    } catch {
      // ignore — form-chart continuity is best-effort
    }
  }

  return {success: true};
});
