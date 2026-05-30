import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { subtractStats } from "../../utils/statsCalculator.js";
import { assertClubMember } from "../../services/firebaseAuth.js";
import type { CareerStats } from "../../types/index.js";

const REGION = "australia-southeast1";

export const revertClaim = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { claimId } = request.data as { claimId: string };
    if (!claimId) throw new HttpsError("invalid-argument", "Missing claimId");

    const db = getFirestore();

    await db.runTransaction(async (tx) => {
      const claimRef = db.collection("claims").doc(claimId);
      const claimSnap = await tx.get(claimRef);
      if (!claimSnap.exists) throw new HttpsError("not-found", "Claim not found");

      const claim = claimSnap.data()!;

      await assertClubMember(uid, claim.clubId);

      const ghostRef = db.collection("players").doc(claim.ghostPlayerId);
      const now = Timestamp.now();

      if (claim.status === "cooldown") {
        // Trivial reset — stats were never touched
        tx.update(claimRef, { status: "rejected", updatedAt: now });
        tx.update(ghostRef, {
          claimStatus: "open",
          activeClaim: FieldValue.delete(),
          updatedAt: now,
        });
        return;
      }

      if (claim.status === "merged") {
        const registeredRef = db.collection("players").doc(claim.registeredPlayerId);
        const registeredSnap = await tx.get(registeredRef);
        if (!registeredSnap.exists) throw new HttpsError("not-found", "Registered player not found");

        const ghostStats = claim.snapshot.ghostStats as CareerStats;
        const currentStats = registeredSnap.data()!.careerStats as CareerStats;
        const revertedStats = subtractStats(currentStats, ghostStats);

        const decrementUpdates: Record<string, FirebaseFirestore.FieldValue | number> = {
          "careerStats.totalRuns": FieldValue.increment(-ghostStats.totalRuns),
          "careerStats.totalWickets": FieldValue.increment(-ghostStats.totalWickets),
          "careerStats.totalBallsFaced": FieldValue.increment(-ghostStats.totalBallsFaced),
          "careerStats.totalDismissals": FieldValue.increment(-ghostStats.totalDismissals),
          "careerStats.totalBallsBowled": FieldValue.increment(-ghostStats.totalBallsBowled),
          "careerStats.totalRunsConceded": FieldValue.increment(-ghostStats.totalRunsConceded),
          "careerStats.totalCatches": FieldValue.increment(-ghostStats.totalCatches),
          "careerStats.totalRunOuts": FieldValue.increment(-ghostStats.totalRunOuts),
          "careerStats.matchesPlayed": FieldValue.increment(-ghostStats.matchesPlayed),
          "careerStats.highScore": revertedStats.highScore,
          updatedAt: now,
        };

        tx.update(registeredRef, decrementUpdates);

        tx.update(ghostRef, {
          playerType: "ghost",
          claimStatus: "open",
          linkedPlayerId: FieldValue.delete(),
          activeClaim: FieldValue.delete(),
          updatedAt: now,
        });

        tx.update(claimRef, { status: "reverted", updatedAt: now });

        // Promote waiting claim if ghost was contested
        const waitingClaimId: string | undefined = claim.waitingClaimId;
        if (waitingClaimId) {
          const waitingRef = db.collection("claims").doc(waitingClaimId);
          tx.update(waitingRef, { status: "cooldown", updatedAt: now });
          tx.update(ghostRef, {
            claimStatus: "cooldown",
            activeClaim: waitingClaimId,
            waitingClaimId: FieldValue.delete(),
          });
        }

        return;
      }

      throw new HttpsError("failed-precondition", `Cannot revert claim with status: ${claim.status}`);
    });

    return { success: true };
  }
);
