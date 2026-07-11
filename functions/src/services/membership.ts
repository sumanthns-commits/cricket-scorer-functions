import {FieldValue} from "firebase-admin/firestore";

/**
 * Flips a registered member's player doc back to a ghost — leaving/removal.
 * careerStats is deliberately never touched (no read, no write): the same
 * doc/id is reused so a rejoin (resolveJoinRequest's self-reactivation
 * branch) finds the exact same stats waiting, untouched, whenever it happens.
 *
 * Pass `tx` when the caller needs the read that decided to call this (e.g.
 * a last-admin count) to be part of the same atomic transaction — otherwise
 * this runs as a plain batch.
 */
export async function deactivatePlayer(
  db: FirebaseFirestore.Firestore,
  clubId: string,
  playerId: string,
  tx?: FirebaseFirestore.Transaction,
): Promise<void> {
  const playerRef = db.collection("clubs").doc(clubId).collection("players").doc(playerId);
  const membershipRef = db.collection("userMemberships").doc(playerId);
  const playerFields = {
    type: "ghost",
    status: "departed",
    departedAt: FieldValue.serverTimestamp(),
    role: "member",
  };
  const membershipFields = {clubIds: FieldValue.arrayRemove(clubId)};

  if (tx) {
    tx.update(playerRef, playerFields);
    tx.set(membershipRef, membershipFields, {merge: true});
    return;
  }

  const batch = db.batch();
  batch.update(playerRef, playerFields);
  batch.set(membershipRef, membershipFields, {merge: true});
  await batch.commit();
}
