import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { mergeStatsFromTotals } from "../../utils/statsCalculator.js";
import { assertAdmin } from "../../services/firebaseAuth.js";
import type { CareerStats } from "../../types/index.js";

const REGION = "australia-southeast1";

type Outcome = "claim1wins" | "claim2wins" | "rejectboth";

export const resolveContest = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { ghostPlayerId, outcome } = request.data as {
      ghostPlayerId: string;
      outcome: Outcome;
    };

    if (!ghostPlayerId || !outcome) {
      throw new HttpsError("invalid-argument", "Missing required fields");
    }

    await assertAdmin(uid);

    const db = getFirestore();

    await db.runTransaction(async (tx) => {
      const ghostRef = db.collection("players").doc(ghostPlayerId);
      const ghostSnap = await tx.get(ghostRef);
      if (!ghostSnap.exists) throw new HttpsError("not-found", "Ghost player not found");

      const ghost = ghostSnap.data()!;
      if (ghost.claimStatus !== "contested") {
        throw new HttpsError("failed-precondition", "Ghost is not in contested state");
      }

      const activeClaim1Id: string = ghost.activeClaim;
      const waitingClaim2Id: string = ghost.waitingClaimId;

      const [claim1Snap, claim2Snap] = await Promise.all([
        tx.get(db.collection("claims").doc(activeClaim1Id)),
        tx.get(db.collection("claims").doc(waitingClaim2Id)),
      ]);

      if (!claim1Snap.exists || !claim2Snap.exists) {
        throw new HttpsError("internal", "Contest claims not found");
      }

      const now = Timestamp.now();

      if (outcome === "rejectboth") {
        tx.update(claim1Snap.ref, { status: "rejected", resolvedBy: uid, updatedAt: now });
        tx.update(claim2Snap.ref, { status: "rejected", resolvedBy: uid, updatedAt: now });
        tx.update(ghostRef, {
          claimStatus: "open",
          activeClaim: FieldValue.delete(),
          waitingClaimId: FieldValue.delete(),
          updatedAt: now,
        });
        return;
      }

      const winnerSnap = outcome === "claim1wins" ? claim1Snap : claim2Snap;
      const loserSnap = outcome === "claim1wins" ? claim2Snap : claim1Snap;
      const winnerClaim = winnerSnap.data()!;

      const registeredRef = db.collection("players").doc(winnerClaim.registeredPlayerId);
      const registeredSnap = await tx.get(registeredRef);
      if (!registeredSnap.exists) throw new HttpsError("not-found", "Registered player not found");

      const ghostStats = winnerClaim.snapshot.ghostStats as CareerStats;
      const registeredStats = registeredSnap.data()!.careerStats as CareerStats;
      const mergedStats = mergeStatsFromTotals(ghostStats, registeredStats);

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

      if (ghostStats.highScore > (registeredStats.highScore ?? 0)) {
        incrementUpdates["careerStats.highScore"] = mergedStats.highScore;
      }

      tx.update(registeredRef, incrementUpdates);

      tx.update(ghostRef, {
        playerType: "linked",
        claimStatus: "merged",
        linkedPlayerId: winnerClaim.registeredPlayerId,
        activeClaim: FieldValue.delete(),
        waitingClaimId: FieldValue.delete(),
        updatedAt: now,
      });

      tx.update(winnerSnap.ref, {
        status: "merged",
        resolvedBy: uid,
        snapshot: { ...winnerClaim.snapshot, registeredStats, mergedStats },
        mergedAt: now,
        updatedAt: now,
      });

      tx.update(loserSnap.ref, { status: "rejected", resolvedBy: uid, updatedAt: now });
    });

    return { success: true };
  }
);
