import { onObjectFinalized } from "firebase-functions/v2/storage";
import { getStorage } from "firebase-admin/storage";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { PDFParse } from "pdf-parse";
import { findMatches } from "../../services/fuzzyMatcher.js";
import type { CareerStats } from "../../types/index.js";

const REGION = "australia-southeast1";

interface ParsedPlayerRow {
  rawName: string;
  stats: Partial<CareerStats>;
}

function parseCSV(content: string): ParsedPlayerRow[] {
  const lines = content.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const rows: ParsedPlayerRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ""; });

    const rawName = row["name"] ?? row["player"] ?? "";
    if (!rawName) continue;

    rows.push({
      rawName,
      stats: {
        totalRuns: parseInt(row["runs"] ?? "0") || 0,
        totalWickets: parseInt(row["wickets"] ?? "0") || 0,
        totalBallsFaced: parseInt(row["balls_faced"] ?? "0") || 0,
        totalDismissals: parseInt(row["dismissals"] ?? "0") || 0,
        totalBallsBowled: parseInt(row["balls_bowled"] ?? "0") || 0,
        totalRunsConceded: parseInt(row["runs_conceded"] ?? "0") || 0,
        totalCatches: parseInt(row["catches"] ?? "0") || 0,
        totalRunOuts: parseInt(row["run_outs"] ?? "0") || 0,
        highScore: parseInt(row["high_score"] ?? "0") || 0,
        matchesPlayed: parseInt(row["matches"] ?? "0") || 0,
      },
    });
  }

  return rows;
}

function parsePDFText(text: string): ParsedPlayerRow[] {
  // Basic line-by-line extraction — adapt pattern to actual PDF format
  const rows: ParsedPlayerRow[] = [];
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Expect format: "Name Runs Wickets ..."
    const parts = line.split(/\s{2,}/);
    if (parts.length < 2) continue;
    const rawName = parts[0];
    if (!rawName || /^\d/.test(rawName)) continue;

    rows.push({
      rawName,
      stats: {
        totalRuns: parseInt(parts[1] ?? "0") || 0,
        totalWickets: parseInt(parts[2] ?? "0") || 0,
        matchesPlayed: parseInt(parts[3] ?? "0") || 0,
      },
    });
  }

  return rows;
}

const emptyStats = (): CareerStats => ({
  totalRuns: 0,
  totalWickets: 0,
  totalBallsFaced: 0,
  totalDismissals: 0,
  totalBallsBowled: 0,
  totalRunsConceded: 0,
  totalCatches: 0,
  totalRunOuts: 0,
  highScore: 0,
  matchesPlayed: 0,
});

export const onStatsImport = onObjectFinalized(
  { region: REGION },
  async (event) => {
    const filePath = event.data.name;
    const contentType = event.data.contentType ?? "";

    // Expect path: imports/{clubId}/{filename}
    const parts = filePath.split("/");
    if (parts[0] !== "imports" || parts.length < 3) return;
    const clubId = parts[1];

    const bucket = getStorage().bucket(event.data.bucket);
    const file = bucket.file(filePath);
    const [buffer] = await file.download();

    let rows: ParsedPlayerRow[] = [];

    if (contentType === "text/csv" || filePath.endsWith(".csv")) {
      rows = parseCSV(buffer.toString("utf-8"));
    } else if (contentType === "application/pdf" || filePath.endsWith(".pdf")) {
      const parser = new PDFParse({ data: new Uint8Array(buffer) });
      const result = await parser.getText();
      rows = parsePDFText(result.text);
    } else {
      return;
    }

    if (rows.length === 0) return;

    const db = getFirestore();
    const now = Timestamp.now();

    // Dedup by rawName
    const seen = new Set<string>();
    const unique = rows.filter((r) => {
      if (seen.has(r.rawName)) return false;
      seen.add(r.rawName);
      return true;
    });

    // Check existing ghost players to avoid duplicates
    const existingSnap = await db
      .collection("players")
      .where("clubId", "==", clubId)
      .where("playerType", "==", "ghost")
      .get();

    const existingNames = new Set(existingSnap.docs.map((d) => d.data().rawName as string));

    const toCreate = unique.filter((r) => !existingNames.has(r.rawName));

    // Batch create ghost players (Firestore max 500 per batch)
    for (let i = 0; i < toCreate.length; i += 499) {
      const batch = db.batch();
      const chunk = toCreate.slice(i, i + 499);

      for (const row of chunk) {
        const ref = db.collection("players").doc();
        batch.set(ref, {
          clubId,
          rawName: row.rawName,
          playerType: "ghost",
          careerStats: { ...emptyStats(), ...row.stats },
          fuzzyMatchCandidates: [],
          createdAt: now,
          updatedAt: now,
        });
      }

      await batch.commit();
    }

    // Trigger fuzzy matching for each new ghost
    for (const row of toCreate) {
      const matches = await findMatches(clubId, row.rawName);
      if (matches.length === 0) continue;

      const ghostSnap = await db
        .collection("players")
        .where("clubId", "==", clubId)
        .where("rawName", "==", row.rawName)
        .limit(1)
        .get();

      if (ghostSnap.empty) continue;

      await ghostSnap.docs[0].ref.update({
        fuzzyMatchCandidates: matches.map((m) => m.candidate),
        fuzzyMatchTier: matches[0].tier,
        updatedAt: Timestamp.now(),
      });
    }
  }
);
