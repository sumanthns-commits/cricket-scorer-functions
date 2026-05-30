import { onTaskDispatched } from "firebase-functions/v2/tasks";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { mergeStatsFromTotals } from "../../utils/statsCalculator.js";
import type { CareerStats } from "../../types/index.js";

const REGION = "australia-southeast1";

export const mergeClaimTask = onTaskDispatched(
  { region: REGION, retryConfig: { maxAttempts: 3 } },
  async (request) => {
    const { claimId } = request.data as { claimId: string };
    if (!claimId) return;

    const db = getFirestore();

    await db.runTransaction(async (tx) => {
      const claimRef = db.collection("claims").doc(claimId);
      const claimSnap = await tx.get(claimRef);

      if (!claimSnap.exists) return;

      const claim = claimSnap.data()!;

      // Idempotency guard — only act on cooldown claims
      if (claim.status !== "cooldown") return;

      const ghostRef = db.collection("players").doc(claim.ghostPlayerId);
      const registeredRef = db.collection("players").doc(claim.registeredPlayerId);

      const [ghostSnap, registeredSnap] = await Promise.all([
        tx.get(ghostRef),
        tx.get(registeredRef),
      ]);

      if (!ghostSnap.exists || !registeredSnap.exists) return;

      // Ghost stats always from snapshot
      const ghostStats = claim.snapshot.ghostStats as CareerStats;
      // Registered stats read live at merge time
      const registeredStats = registeredSnap.data()!.careerStats as CareerStats;
      const mergedStats = mergeStatsFromTotals(ghostStats, registeredStats);

      const now = Timestamp.now();

      // Update registered player careerStats using FieldValue.increment
      const incrementUpdates: Record<string, FirebaseFirestore.FieldValue | number> = {
        "careerStats.totalRuns": FieldValue.increment(ghostStats.totalRuns),
        "careerStats.totalWickets": FieldValue.increment(ghostStats.totalWickets),
        "careerStats.totalBallsFaced": FieldValue.increment(ghostStats.totalBallsFaced),
        "careerStats.totalDismissals": FieldValue.increment(ghostStats.totalDismissals),
        "careerStats.totalBallsBowled": FieldValue.increment(ghostStats.totalBallsBowled),
        "careerStats.totalRunsConceded": FieldValue.increment(ghostStats.totalRunsConceded),
        "careerStats.totalCatches": FieldValue.increment(ghostStats.totalCatches),
        "careerStats.totalRunOuts": FieldValue.increment(ghostStats.totalRunOuts),
        "careerStats.matchesPlayed": FieldValue.increment(ghostStats.matchesPlayed),
        updatedAt: now,
      };

      if (ghostStats.highScore > (registeredSnap.data()!.careerStats?.highScore ?? 0)) {
        incrementUpdates["careerStats.highScore"] = mergedStats.highScore;
      }

      tx.update(registeredRef, incrementUpdates);

      tx.update(ghostRef, {
        playerType: "linked",
        claimStatus: "merged",
        linkedPlayerId: claim.registeredPlayerId,
        activeClaim: FieldValue.delete(),
        updatedAt: now,
      });

      tx.update(claimRef, {
        status: "merged",
        snapshot: {
          ...claim.snapshot,
          registeredStats,
          mergedStats,
        },
        mergedAt: now,
        updatedAt: now,
      });
    });
  }
);
