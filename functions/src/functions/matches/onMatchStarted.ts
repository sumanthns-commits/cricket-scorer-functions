import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, Timestamp } from "firebase-admin/firestore";

const REGION = "australia-southeast1";

export const onMatchStarted = onDocumentUpdated(
  { document: "matches/{matchId}", region: REGION },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!before || !after) return;
    if (before.status === after.status) return;
    if (after.status !== "live") return;

    const clubId: string = after.clubId;
    const matchId = event.params.matchId;

    const db = getFirestore();
    const clubSnap = await db.collection("clubs").doc(clubId).get();
    if (!clubSnap.exists) return;

    const clubRules = clubSnap.data()!.rules ?? {};

    await db.collection("matches").doc(matchId).update({
      rules: clubRules,
      rulesLockedAt: Timestamp.now(),
    });
  }
);
