import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const REGION = "australia-southeast1";

interface DeliveryEvent {
  batsmanId: string;
  bowlerId: string;
  runs: number;
  extras: number;
  wicket?: { type: string; fielderId?: string };
  isWide?: boolean;
  isNoBall?: boolean;
}

interface FieldingEvent {
  type: "catch" | "runOut";
  fielderId: string;
}

export const onOverCompleted = onDocumentCreated(
  { document: "matches/{matchId}/overs/{overId}", region: REGION },
  async (event) => {
    const over = event.data?.data();
    if (!over) return;

    const matchId = event.params.matchId;

    const deliveries: DeliveryEvent[] = over.deliveries ?? [];
    const db = getFirestore();
    const batch = db.batch();
    const matchRef = db.collection("matches").doc(matchId);

    // Seal the over doc
    batch.update(event.data!.ref, { sealed: true, sealedAt: Timestamp.now() });

    // Aggregate per-player deltas
    const batsmanRuns = new Map<string, number>();
    const batsmanBalls = new Map<string, number>();
    const bowlerBalls = new Map<string, number>();
    const bowlerRuns = new Map<string, number>();
    const bowlerWickets = new Map<string, number>();
    const batsmanDismissals = new Map<string, number>();
    const fieldingEvents: FieldingEvent[] = [];
    let overRuns = 0;

    for (const d of deliveries) {
      const isLegalDelivery = !d.isWide && !d.isNoBall;

      // Batsman
      batsmanRuns.set(d.batsmanId, (batsmanRuns.get(d.batsmanId) ?? 0) + d.runs);
      if (isLegalDelivery) {
        batsmanBalls.set(d.batsmanId, (batsmanBalls.get(d.batsmanId) ?? 0) + 1);
      }

      // Bowler
      if (isLegalDelivery) {
        bowlerBalls.set(d.bowlerId, (bowlerBalls.get(d.bowlerId) ?? 0) + 1);
      }
      bowlerRuns.set(d.bowlerId, (bowlerRuns.get(d.bowlerId) ?? 0) + d.runs + d.extras);

      overRuns += d.runs + d.extras;

      if (d.wicket) {
        bowlerWickets.set(d.bowlerId, (bowlerWickets.get(d.bowlerId) ?? 0) + 1);
        batsmanDismissals.set(d.batsmanId, (batsmanDismissals.get(d.batsmanId) ?? 0) + 1);

        if (d.wicket.type === "caught" && d.wicket.fielderId) {
          fieldingEvents.push({ type: "catch", fielderId: d.wicket.fielderId });
        }
        if (d.wicket.type === "runOut" && d.wicket.fielderId) {
          fieldingEvents.push({ type: "runOut", fielderId: d.wicket.fielderId });
        }
      }
    }

    // Apply batsman stat increments
    for (const [playerId, runs] of batsmanRuns) {
      const ref = db.collection("players").doc(playerId);
      const updates: Record<string, FirebaseFirestore.FieldValue> = {
        "careerStats.totalRuns": FieldValue.increment(runs),
      };
      const balls = batsmanBalls.get(playerId) ?? 0;
      if (balls > 0) updates["careerStats.totalBallsFaced"] = FieldValue.increment(balls);
      const dismissals = batsmanDismissals.get(playerId) ?? 0;
      if (dismissals > 0) updates["careerStats.totalDismissals"] = FieldValue.increment(dismissals);
      batch.update(ref, updates);
    }

    // Apply bowler stat increments
    for (const [playerId, balls] of bowlerBalls) {
      const ref = db.collection("players").doc(playerId);
      const runs = bowlerRuns.get(playerId) ?? 0;
      const wickets = bowlerWickets.get(playerId) ?? 0;
      const updates: Record<string, FirebaseFirestore.FieldValue> = {
        "careerStats.totalBallsBowled": FieldValue.increment(balls),
        "careerStats.totalRunsConceded": FieldValue.increment(runs),
      };
      if (wickets > 0) updates["careerStats.totalWickets"] = FieldValue.increment(wickets);
      batch.update(ref, updates);
    }

    // Apply fielding stat increments
    const catchCounts = new Map<string, number>();
    const runOutCounts = new Map<string, number>();
    for (const fe of fieldingEvents) {
      if (fe.type === "catch") catchCounts.set(fe.fielderId, (catchCounts.get(fe.fielderId) ?? 0) + 1);
      if (fe.type === "runOut") runOutCounts.set(fe.fielderId, (runOutCounts.get(fe.fielderId) ?? 0) + 1);
    }
    for (const [playerId, count] of catchCounts) {
      batch.update(db.collection("players").doc(playerId), {
        "careerStats.totalCatches": FieldValue.increment(count),
      });
    }
    for (const [playerId, count] of runOutCounts) {
      batch.update(db.collection("players").doc(playerId), {
        "careerStats.totalRunOuts": FieldValue.increment(count),
      });
    }

    // Update liveScore summary on match doc
    batch.update(matchRef, {
      "liveScore.lastOverRuns": overRuns,
      "liveScore.totalRuns": FieldValue.increment(overRuns),
      "liveScore.oversCompleted": FieldValue.increment(1),
      updatedAt: Timestamp.now(),
    });

    await batch.commit();
  }
);
