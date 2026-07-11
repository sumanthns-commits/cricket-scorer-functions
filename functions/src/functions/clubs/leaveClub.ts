import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {deactivatePlayer} from "../../services/membership.js";

const REGION = "australia-southeast1";

/**
 * Self-service: a registered member leaves a club. Flips their player doc
 * to a ghost (careerStats untouched — see deactivatePlayer) and drops the
 * club from their userMemberships index.
 */
export const leaveClub = onCall({region: REGION, invoker: "public"}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

  const {clubId} = request.data as {clubId: string};
  if (!clubId) throw new HttpsError("invalid-argument", "Missing clubId");

  const db = getFirestore();
  const playersRef = db.collection("clubs").doc(clubId).collection("players");
  const playerRef = playersRef.doc(uid);

  await db.runTransaction(async (tx) => {
    const playerSnap = await tx.get(playerRef);
    const player = playerSnap.data();
    if (!playerSnap.exists || player?.type !== "registered") {
      throw new HttpsError("failed-precondition", "Not a registered member of this club");
    }

    // Last-admin guard, read INSIDE the same transaction as the write below
    // — reading this count beforehand (outside the transaction) would leave
    // a window where two admins leaving concurrently could both pass the
    // check before either write lands, leaving the club with zero admins
    // (and no client can ever promote a new one, since that's itself
    // isAdmin-gated).
    if (player.role === "admin") {
      const adminsSnap = await tx.get(
        playersRef.where("type", "==", "registered").where("role", "==", "admin"),
      );
      if (adminsSnap.size <= 1) {
        throw new HttpsError(
          "failed-precondition",
          "You're the only admin — promote another member first",
        );
      }
    }

    await deactivatePlayer(db, clubId, uid, tx);
  });

  return {success: true};
});
