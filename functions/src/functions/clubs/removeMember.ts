import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {deactivatePlayer} from "../../services/membership.js";

const REGION = "australia-southeast1";

/**
 * Admin-only: removes another member from a club. Same end state as
 * leaveClub (careerStats untouched) — the caller-facing difference is just
 * who's authorised and the wording.
 *
 * Last-admin guard runs here too, inside the same transaction as the write:
 * caller≠target alone doesn't rule out two admins concurrently removing
 * EACH OTHER (each call's authorization only reads the caller's own doc), so
 * without this, two admins could simultaneously drop a club to zero admins.
 */
export const removeMember = onCall({region: REGION, invoker: "public"}, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) throw new HttpsError("unauthenticated", "Must be signed in");

  const {clubId, playerId} = request.data as {clubId: string; playerId: string};
  if (!clubId || !playerId) throw new HttpsError("invalid-argument", "Missing fields");
  if (playerId === callerUid) {
    throw new HttpsError("invalid-argument", "Use leaveClub to remove yourself");
  }

  const db = getFirestore();
  const playersRef = db.collection("clubs").doc(clubId).collection("players");

  await db.runTransaction(async (tx) => {
    const [callerSnap, targetSnap] = await Promise.all([
      tx.get(playersRef.doc(callerUid)),
      tx.get(playersRef.doc(playerId)),
    ]);
    if (callerSnap.data()?.role !== "admin") {
      throw new HttpsError("permission-denied", "Admin access required");
    }
    const target = targetSnap.data();
    if (!targetSnap.exists || target?.type !== "registered") {
      throw new HttpsError("failed-precondition", "Player is not a registered member of this club");
    }

    if (target.role === "admin") {
      const adminsSnap = await tx.get(
        playersRef.where("type", "==", "registered").where("role", "==", "admin"),
      );
      if (adminsSnap.size <= 1) {
        throw new HttpsError(
          "failed-precondition",
          "Can't remove the only admin — promote another member first",
        );
      }
    }

    await deactivatePlayer(db, clubId, playerId, tx);
  });

  return {success: true};
});
