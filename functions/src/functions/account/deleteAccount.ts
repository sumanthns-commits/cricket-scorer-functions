import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import {getAuth} from "firebase-admin/auth";

const REGION = "australia-southeast1";

/**
 * Self-service account deletion (Apple Guideline 5.1.1(v)). In every club the
 * caller is a registered member of, flips their player doc to a ghost —
 * same end state as leaveClub/removeMember (careerStats untouched, so match
 * history and stats survive) — then erases personal data (users/{uid},
 * userMemberships/{uid}) and the Firebase Auth user itself.
 * publicPlayerStats mirrors are cleaned up indirectly: mirrorPlayerStats
 * deletes the mirror whenever a player doc's type leaves 'registered'.
 *
 * Membership fields are set inline here rather than via deactivatePlayer,
 * since that helper also arrayRemoves the club from userMemberships — moot
 * when the whole userMemberships doc is deleted a moment later in the same
 * transaction.
 *
 * All club deactivations + doc deletes run in one transaction so a
 * last-admin guard failure in any single club aborts the whole thing rather
 * than leaving the account partially deleted. The Auth user is only deleted
 * after that transaction commits, so a failed cleanup never orphans the
 * account (Firestore data left with no way to sign back in and retry).
 */
export const deleteAccount = onCall({region: REGION, invoker: "public"}, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

  const db = getFirestore();
  const membershipRef = db.collection("userMemberships").doc(uid);
  const userRef = db.collection("users").doc(uid);

  await db.runTransaction(async (tx) => {
    const membershipSnap = await tx.get(membershipRef);
    const clubIds = (membershipSnap.data()?.clubIds as string[] | undefined) ?? [];

    // All reads across every club must happen before any writes in a
    // Firestore transaction.
    const clubReads = await Promise.all(
      clubIds.map(async (clubId) => {
        const playersRef = db.collection("clubs").doc(clubId).collection("players");
        const playerSnap = await tx.get(playersRef.doc(uid));
        const player = playerSnap.data();
        const adminsSnap = player?.role === "admin"
          ? await tx.get(playersRef.where("type", "==", "registered").where("role", "==", "admin"))
          : null;
        return {clubId, playerRef: playersRef.doc(uid), player, adminsSnap};
      }),
    );

    for (const {clubId, player, adminsSnap} of clubReads) {
      if (player?.role === "admin" && (adminsSnap?.size ?? 0) <= 1) {
        throw new HttpsError(
          "failed-precondition",
          `You're the only admin of a club (${clubId}) — promote another member there before deleting your account`,
        );
      }
    }

    for (const {playerRef, player} of clubReads) {
      if (player?.type === "registered") {
        tx.update(playerRef, {
          type: "ghost",
          status: "departed",
          departedAt: FieldValue.serverTimestamp(),
          role: "member",
        });
      }
    }

    tx.delete(userRef);
    tx.delete(membershipRef);
  });

  await getAuth().deleteUser(uid);

  return {success: true};
});
