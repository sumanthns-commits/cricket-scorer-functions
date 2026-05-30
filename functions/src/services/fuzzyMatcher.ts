import { distance } from "fastest-levenshtein";
import { getFirestore } from "firebase-admin/firestore";
import type { FuzzyCandidate } from "../types/index.js";

const AUTO_SUGGEST_THRESHOLD = 0.90;
const ADMIN_QUEUE_THRESHOLD = 0.75;

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, " ");
}

function initialsOf(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0] ?? "")
    .join("")
    .toLowerCase();
}

function surnameOf(name: string): string {
  const parts = name.trim().split(" ");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

export function fuzzyScore(rawName: string, candidateName: string): number {
  const a = normalizeName(rawName);
  const b = normalizeName(candidateName);

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;

  const editScore = 1 - distance(a, b) / maxLen;

  const initialsA = initialsOf(a);
  const initialsB = initialsOf(b);
  const initialsScore = initialsA === initialsB ? 0.05 : 0;

  const surnameA = surnameOf(a);
  const surnameB = surnameOf(b);
  const surnameScore = surnameA === surnameB ? 0.1 : 0;

  return Math.min(1, editScore + initialsScore + surnameScore);
}

export interface MatchResult {
  candidate: FuzzyCandidate;
  tier: "auto" | "queue";
}

export async function findMatches(clubId: string, rawName: string): Promise<MatchResult[]> {
  const db = getFirestore();
  const snap = await db
    .collection("players")
    .where("clubId", "==", clubId)
    .where("playerType", "==", "registered")
    .get();

  const results: MatchResult[] = [];

  for (const doc of snap.docs) {
    const data = doc.data();
    const displayName: string = data.displayName ?? "";
    const score = fuzzyScore(rawName, displayName);

    if (score >= AUTO_SUGGEST_THRESHOLD) {
      results.push({
        candidate: { playerId: doc.id, displayName, score },
        tier: "auto",
      });
    } else if (score >= ADMIN_QUEUE_THRESHOLD) {
      results.push({
        candidate: { playerId: doc.id, displayName, score },
        tier: "queue",
      });
    }
  }

  return results.sort((a, b) => b.candidate.score - a.candidate.score);
}
