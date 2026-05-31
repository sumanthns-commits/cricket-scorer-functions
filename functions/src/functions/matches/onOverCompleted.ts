import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const REGION = "australia-southeast1";

interface DeliveryEvent {
  batsmanId: string;
  bowlerId: string;
  runs: number;
  extras: number;
  wicket?: { type: string; fielderId?: string; fielderIds?: string[] };
  fieldingInsights?: Array<{ playerId: string; type: string }>;
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

    const matchSnap = await matchRef.get();
    const clubId = matchSnap.data()?.clubId as string | undefined;

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
    // keyed by `${batsmanId}_${bowlerId}`
    const h2hDeltas = new Map<string, { runs: number; balls: number; dismissals: number }>();
    // keyed by playerId → insight type → count
    const fieldingInsightCounts = new Map<string, Map<string, number>>();
    let overRuns = 0;

    for (const d of deliveries) {
      const isLegalDelivery = !d.isWide && !d.isNoBall;

      const h2hKey = `${d.batsmanId}_${d.bowlerId}`;
      const h2h = h2hDeltas.get(h2hKey) ?? { runs: 0, balls: 0, dismissals: 0 };
      h2h.runs += d.runs;
      if (isLegalDelivery) h2h.balls += 1;
      if (d.wicket && d.wicket.type !== "runOut") h2h.dismissals += 1;
      h2hDeltas.set(h2hKey, h2h);

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

      for (const fi of d.fieldingInsights ?? []) {
        const byType = fieldingInsightCounts.get(fi.playerId) ?? new Map<string, number>();
        byType.set(fi.type, (byType.get(fi.type) ?? 0) + 1);
        fieldingInsightCounts.set(fi.playerId, byType);
      }

      if (d.wicket) {
        bowlerWickets.set(d.bowlerId, (bowlerWickets.get(d.bowlerId) ?? 0) + 1);
        batsmanDismissals.set(d.batsmanId, (batsmanDismissals.get(d.batsmanId) ?? 0) + 1);

        if (d.wicket.type === "caught" && d.wicket.fielderId) {
          fieldingEvents.push({ type: "catch", fielderId: d.wicket.fielderId });
        }
        if (d.wicket.type === "runOut") {
          const ids = d.wicket.fielderIds ?? (d.wicket.fielderId ? [d.wicket.fielderId] : []);
          for (const fid of ids) {
            fieldingEvents.push({ type: "runOut", fielderId: fid });
          }
        }
      }
    }

    const applyToPlayer = (playerId: string, updates: Record<string, FirebaseFirestore.FieldValue>) => {
      batch.update(db.collection("players").doc(playerId), updates);
      if (clubId) {
        batch.update(
          db.collection("clubs").doc(clubId).collection("players").doc(playerId),
          updates,
        );
      }
    };

    // Apply batsman stat increments
    for (const [playerId, runs] of batsmanRuns) {
      const updates: Record<string, FirebaseFirestore.FieldValue> = {
        "careerStats.totalRuns": FieldValue.increment(runs),
      };
      const balls = batsmanBalls.get(playerId) ?? 0;
      if (balls > 0) updates["careerStats.totalBallsFaced"] = FieldValue.increment(balls);
      const dismissals = batsmanDismissals.get(playerId) ?? 0;
      if (dismissals > 0) updates["careerStats.totalDismissals"] = FieldValue.increment(dismissals);
      applyToPlayer(playerId, updates);
    }

    // Apply bowler stat increments
    for (const [playerId, balls] of bowlerBalls) {
      const runs = bowlerRuns.get(playerId) ?? 0;
      const wickets = bowlerWickets.get(playerId) ?? 0;
      const updates: Record<string, FirebaseFirestore.FieldValue> = {
        "careerStats.totalBallsBowled": FieldValue.increment(balls),
        "careerStats.totalRunsConceded": FieldValue.increment(runs),
      };
      if (wickets > 0) updates["careerStats.totalWickets"] = FieldValue.increment(wickets);
      applyToPlayer(playerId, updates);
    }

    // Apply fielding stat increments
    const catchCounts = new Map<string, number>();
    const runOutCounts = new Map<string, number>();
    for (const fe of fieldingEvents) {
      if (fe.type === "catch") catchCounts.set(fe.fielderId, (catchCounts.get(fe.fielderId) ?? 0) + 1);
      if (fe.type === "runOut") runOutCounts.set(fe.fielderId, (runOutCounts.get(fe.fielderId) ?? 0) + 1);
    }
    for (const [playerId, count] of catchCounts) {
      applyToPlayer(playerId, { "careerStats.totalCatches": FieldValue.increment(count) });
    }
    for (const [playerId, count] of runOutCounts) {
      applyToPlayer(playerId, { "careerStats.totalRunOuts": FieldValue.increment(count) });
    }

    // Apply fielding insight increments
    for (const [playerId, byType] of fieldingInsightCounts) {
      const updates: Record<string, FirebaseFirestore.FieldValue> = {};
      for (const [type, count] of byType) {
        updates[`fieldingInsights.${type}`] = FieldValue.increment(count);
      }
      applyToPlayer(playerId, updates);
    }

    // Apply head-to-head stat increments (with per-innings breakdown)
    if (clubId) {
      const inningsNumber = over.inningsNumber as number | undefined;
      const inningsKey = inningsNumber != null ? `byInnings.i${inningsNumber}` : null;

      for (const [key, delta] of h2hDeltas) {
        const [batsmanId, bowlerId] = key.split("_");
        const docId = `${clubId}_${batsmanId}_${bowlerId}`;
        const updates: Record<string, unknown> = {
          clubId,
          batsmanId,
          bowlerId,
          runs: FieldValue.increment(delta.runs),
          balls: FieldValue.increment(delta.balls),
        };
        if (delta.dismissals > 0) updates["dismissals"] = FieldValue.increment(delta.dismissals);
        if (inningsKey) {
          updates[`${inningsKey}.runs`] = FieldValue.increment(delta.runs);
          updates[`${inningsKey}.balls`] = FieldValue.increment(delta.balls);
          if (delta.dismissals > 0) updates[`${inningsKey}.dismissals`] = FieldValue.increment(delta.dismissals);
        }
        batch.set(db.collection("headToHead").doc(docId), updates, { merge: true });
      }
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
