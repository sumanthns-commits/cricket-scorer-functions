import { getFirestore, FieldValue } from "firebase-admin/firestore";
import type { CareerStats } from "../types/index.js";

export async function applyStatsDelta(
  playerId: string,
  delta: Partial<CareerStats>,
  batch: FirebaseFirestore.WriteBatch
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection("players").doc(playerId);

  const updates: Record<string, FirebaseFirestore.FieldValue | number> = {};
  for (const [key, value] of Object.entries(delta)) {
    if (key === "highScore") {
      // highScore is not additive; caller must handle separately
      continue;
    }
    if (typeof value === "number") {
      updates[`careerStats.${key}`] = FieldValue.increment(value);
    }
  }

  if (Object.keys(updates).length > 0) {
    batch.update(ref, updates);
  }
}

export async function resolveHighScore(
  playerId: string,
  newScore: number,
  batch: FirebaseFirestore.WriteBatch
): Promise<void> {
  const db = getFirestore();
  const ref = db.collection("players").doc(playerId);
  const snap = await ref.get();
  const current: number = snap.data()?.careerStats?.highScore ?? 0;
  if (newScore > current) {
    batch.update(ref, { "careerStats.highScore": newScore });
  }
}
