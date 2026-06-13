/**
 * One-off backfill for data that onMatchCompleted only started producing after
 * deploy: per-match `playerPerformances` rows (powering the profile "Last 5"
 * form chart) and the `careerStats.wagonWheel` shot map.
 *
 * SAFE TO RE-RUN. It never touches existing career counters (runs, wickets,
 * etc. were already aggregated at completion time). It only:
 *   - SETs playerPerformances/{matchId}_{playerId} (deterministic id, idempotent)
 *   - SETs careerStats.wagonWheel from a full recompute (overwrite, idempotent)
 *
 * Usage (from functions/):
 *   npm run build
 *   GOOGLE_APPLICATION_CREDENTIALS=path/to/sa.json \
 *     node lib/scripts/backfillPerformances.js <projectId> [--dry-run]
 *
 * Auth: uses Application Default Credentials. Either set
 * GOOGLE_APPLICATION_CREDENTIALS to a service-account key, or run after
 * `gcloud auth application-default login`.
 */
import {initializeApp, applicationDefault} from "firebase-admin/app";
import {getFirestore} from "firebase-admin/firestore";

const BOWLER_CREDIT = new Set(["bowled", "caught", "lbw", "stumped", "hit-wicket"]);
const WAGON_SECTORS = 12;

interface BallEntry {
  runs: number;
  batsmanId: string;
  extras?: { type: string; runs: number };
  dismissal?: { type: string };
  wagon?: { sector: number; depth: number };
}

interface OverDoc {
  inningsId?: string;
  overNumber: number;
  bowlerId: string;
  balls?: BallEntry[];
}

interface PlayerMatch {
  battingRuns: number;
  ballsFaced: number;
  dismissed: boolean;
  wickets: number;
  wagon: number[];
}

function emptyPM(): PlayerMatch {
  return {
    battingRuns: 0,
    ballsFaced: 0,
    dismissed: false,
    wickets: 0,
    wagon: new Array<number>(WAGON_SECTORS).fill(0),
  };
}

async function main() {
  const projectId = process.argv[2];
  const dryRun = process.argv.includes("--dry-run");
  if (!projectId) {
    console.error("Usage: node lib/scripts/backfillPerformances.js <projectId> [--dry-run]");
    process.exit(1);
  }

  initializeApp({credential: applicationDefault(), projectId});
  const db = getFirestore();

  console.log(`Backfill starting for project "${projectId}"${dryRun ? " (DRY RUN)" : ""}`);

  let perfDocs = 0;
  let wagonPlayers = 0;
  let matchesProcessed = 0;

  const clubsSnap = await db.collection("clubs").get();
  for (const clubDoc of clubsSnap.docs) {
    const clubId = clubDoc.id;

    const matchesSnap = await clubDoc.ref
      .collection("matches")
      .where("status", "==", "completed")
      .get();
    if (matchesSnap.empty) continue;

    // Club-wide wagon accumulator (summed across all the club's matches).
    const clubWagon = new Map<string, number[]>();
    const wagonOf = (id: string): number[] => {
      let w = clubWagon.get(id);
      if (!w) {
        w = new Array<number>(WAGON_SECTORS).fill(0);
        clubWagon.set(id, w);
      }
      return w;
    };

    for (const matchDoc of matchesSnap.docs) {
      const match = matchDoc.data();
      const teamA: string[] = match.teamA ?? [];
      const teamB: string[] = match.teamB ?? [];
      const played = Array.from(new Set([...teamA, ...teamB]));
      if (played.length === 0) continue;

      const homeTeam: string = match.homeTeam ?? "Home";
      const awayTeam: string = match.awayTeam ?? "Away";
      const createdAt = match.date ?? matchDoc.createTime ?? null;

      const oversSnap = await matchDoc.ref.collection("overs").get();
      const overs = oversSnap.docs
        .map((d) => d.data() as OverDoc)
        .sort((a, b) => a.overNumber - b.overNumber);

      const pm = new Map<string, PlayerMatch>();
      const pmOf = (id: string): PlayerMatch => {
        let v = pm.get(id);
        if (!v) {
          v = emptyPM();
          pm.set(id, v);
        }
        return v;
      };

      for (const over of overs) {
        for (const ball of over.balls ?? []) {
          const isWideNoBall = ball.extras?.type === "wide" || ball.extras?.type === "no-ball";
          const isLegal = !isWideNoBall;

          const bat = pmOf(ball.batsmanId);
          bat.battingRuns += ball.runs;
          if (isLegal) bat.ballsFaced += 1;

          const sector = ball.wagon?.sector;
          if (typeof sector === "number" && sector >= 0 && sector < WAGON_SECTORS) {
            bat.wagon[sector] += ball.runs;
            wagonOf(ball.batsmanId)[sector] += ball.runs;
          }

          if (ball.dismissal) {
            bat.dismissed = true;
            if (BOWLER_CREDIT.has(ball.dismissal.type)) pmOf(over.bowlerId).wickets += 1;
          }
        }
      }

      const batch = db.batch();
      for (const id of played) {
        const m = pm.get(id) ?? emptyPM();
        const opponent = teamA.includes(id) ? awayTeam : homeTeam;
        batch.set(db.collection("playerPerformances").doc(`${matchDoc.id}_${id}`), {
          clubId,
          matchId: matchDoc.id,
          playerId: id,
          opponent,
          label: opponent,
          runs: m.battingRuns,
          ballsFaced: m.ballsFaced,
          wickets: m.wickets,
          notOut: m.ballsFaced > 0 && !m.dismissed,
          createdAt,
        });
        perfDocs++;
      }
      if (!dryRun) await batch.commit();
      matchesProcessed++;
    }

    // Write each player's summed wagon map (merge so career counters survive).
    const wagonBatch = db.batch();
    for (const [playerId, wagon] of clubWagon) {
      if (wagon.every((v) => v === 0)) continue;
      const wagonMap: Record<string, number> = {};
      wagon.forEach((runs, sector) => {
        if (runs > 0) wagonMap[String(sector)] = runs;
      });
      wagonBatch.set(
        clubDoc.ref.collection("players").doc(playerId),
        {careerStats: {wagonWheel: wagonMap}},
        {merge: true},
      );
      wagonPlayers++;
    }
    if (!dryRun) await wagonBatch.commit();

    console.log(`  club ${clubId}: ${matchesSnap.size} matches`);
  }

  console.log(
    `Done. ${matchesProcessed} matches → ${perfDocs} performance docs, ` +
      `${wagonPlayers} players with wagon data${dryRun ? " (nothing written)" : ""}.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
