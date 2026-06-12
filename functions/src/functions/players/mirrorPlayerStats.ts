import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const REGION = "australia-southeast1";

/**
 * Mirrors each REGISTERED player's per-club career stats into a public,
 * signed-in-readable collection (`publicPlayerStats/{uid}_{clubId}`) so a club
 * admin can review a join requester's record across every club they belong to
 * without reading the (member-private) `clubs/{clubId}/players` docs.
 *
 * Triggers on every player-doc write: this seeds the mirror when a player is
 * created (club creator, approved joiner) AND keeps it in sync afterwards,
 * because onMatchCompleted writes career stats back to the player doc — which
 * re-fires this trigger. Ghost players (no auth uid) are skipped; their doc id
 * is not a real uid and they never raise join requests.
 */
export const mirrorPlayerStats = onDocumentWritten(
  { document: "clubs/{clubId}/players/{playerId}", region: REGION },
  async (event) => {
    const clubId = event.params.clubId as string;
    const playerId = event.params.playerId as string;
    const mirrorId = `${playerId}_${clubId}`;

    const db = getFirestore();
    const mirrorRef = db.collection("publicPlayerStats").doc(mirrorId);

    const after = event.data?.after.data();

    // Player removed (or no longer registered) → drop the mirror.
    if (!after || after.type !== "registered") {
      await mirrorRef.delete().catch(() => undefined);
      return;
    }

    // Club name is denormalised into the mirror so the review UI can label each
    // row without reading the member-private club doc.
    const clubSnap = await db.collection("clubs").doc(clubId).get();
    const clubName = (clubSnap.data()?.name as string | undefined) ?? "";

    await mirrorRef.set(
      {
        uid: playerId,
        clubId,
        clubName,
        displayName: after.displayName ?? "",
        photoURL: after.photoURL ?? null,
        careerStats: after.careerStats ?? {},
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  },
);
