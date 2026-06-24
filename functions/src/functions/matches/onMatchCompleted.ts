import {onDocumentUpdated} from "firebase-functions/v2/firestore";
import {getFirestore, FieldValue} from "firebase-admin/firestore";

const REGION = "australia-southeast1";

// Dismissal types that credit the bowler (others are run-outs etc.).
const BOWLER_CREDIT = new Set(["bowled", "caught", "lbw", "stumped", "hit-wicket"]);

// Rating points awarded per non-dismissal fielding event, by the event's
// admin-configured polarity. Comparable scale to a dismissal (+5 in
// computeSkillRating). Unknown/legacy polarity → neutral (no effect).
const POLARITY_POINTS: Record<string, number> = {
  positive: 3,
  negative: -3,
  neutral: 0,
};

interface BallEntry {
  runs: number;
  batsmanId: string;
  extras?: { type: string; runs: number };
  dismissal?: { type: string; fielderId?: string; fielderIds?: string[]; bowlerId?: string };
  fielding?: { eventId?: string; eventLabel?: string; fielderId?: string; fielderIds?: string[] };
  wagon?: { sector: number; depth: number };
}

const WAGON_SECTORS = 12;

interface OverDoc {
  inningsId: string;
  overNumber: number;
  bowlerId: string;
  balls?: BallEntry[];
}

interface PlayerMatch {
  battingRuns: number;
  ballsFaced: number;
  dismissed: boolean;
  ballsBowled: number;
  runsConceded: number;
  wickets: number;
  catches: number;
  runOuts: number;
  stumpings: number;
  fieldingEvents: Record<string, number>; // event label → count
  fieldingPoints: number; // signed rating points from non-dismissal events
  wagon: number[]; // runs off the bat per wagon-wheel sector (length 12)
}

function emptyPM(): PlayerMatch {
  return {
    battingRuns: 0, ballsFaced: 0, dismissed: false,
    ballsBowled: 0, runsConceded: 0, wickets: 0, catches: 0, runOuts: 0,
    stumpings: 0,
    fieldingEvents: {},
    fieldingPoints: 0,
    wagon: new Array<number>(WAGON_SECTORS).fill(0),
  };
}

type FsUpdate = Record<string, FirebaseFirestore.FieldValue | number | Record<string, number>>;

/**
 * Aggregates per-player career + captain stats when a match completes.
 * Triggers on the REAL app path (clubs/{clubId}/matches/{matchId}) and reads the
 * real over schema (balls: BallEntry[]). Admin SDK → bypasses Firestore rules.
 */
export const onMatchCompleted = onDocumentUpdated(
  {document: "clubs/{clubId}/matches/{matchId}", region: REGION},
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (after.status !== "completed" || before.status === "completed") return;
    if (after.statsAggregated) return; // idempotency guard

    const clubId = event.params.clubId as string;
    const matchId = event.params.matchId as string;
    const teamA: string[] = after.teamA ?? [];
    const teamB: string[] = after.teamB ?? [];
    // homeTeam == teamA, awayTeam == teamB (see winner logic below).
    const homeTeam: string = after.homeTeam ?? "Home";
    const awayTeam: string = after.awayTeam ?? "Away";
    const matchDate: FirebaseFirestore.Timestamp | undefined = after.date;
    const captainA: string | undefined = after.captainA ?? undefined;
    const captainB: string | undefined = after.captainB ?? undefined;
    const toss = after.toss as { winnerId?: string; choice?: string } | undefined;

    // Fielding-event polarity → rating points, resolved from THIS match's rules
    // snapshot (label-keyed, matching fieldingEvents on each ball). Baking the
    // points now freezes them against later label renames / polarity edits.
    const feEvents = (after.rules?.fieldingEvents ?? []) as Array<{
      label?: string;
      polarity?: string;
    }>;
    const fePoints = new Map<string, number>();
    for (const ev of feEvents) {
      if (ev.label) fePoints.set(ev.label, POLARITY_POINTS[ev.polarity ?? "neutral"] ?? 0);
    }

    const db = getFirestore();
    const matchRef = db.collection("clubs").doc(clubId).collection("matches").doc(matchId);

    const oversSnap = await matchRef.collection("overs").get();
    const overs = oversSnap.docs
      .map((d) => d.data() as OverDoc)
      .sort((a, b) => a.overNumber - b.overNumber);

    const pm = new Map<string, PlayerMatch>();
    const pmOf = (id: string): PlayerMatch => {
      let v = pm.get(id);
      if (!v) {
        v = emptyPM(); pm.set(id, v);
      }
      return v;
    };
    const inningsTotal: Record<string, number> = {};

    for (const over of overs) {
      const innings = over.inningsId ?? "innings-1";
      for (const ball of over.balls ?? []) {
        const isWideNoBall = ball.extras?.type === "wide" || ball.extras?.type === "no-ball";
        const isLegal = !isWideNoBall;
        const extraRuns = ball.extras?.runs ?? 0;

        inningsTotal[innings] = (inningsTotal[innings] ?? 0) + ball.runs + extraRuns;

        const bat = pmOf(ball.batsmanId);
        bat.battingRuns += ball.runs;
        if (isLegal) bat.ballsFaced += 1;

        // Shot placement: credit runs off the bat to the wagon-wheel sector.
        const sector = ball.wagon?.sector;
        if (typeof sector === "number" && sector >= 0 && sector < WAGON_SECTORS) {
          bat.wagon[sector] += ball.runs;
        }

        const bowl = pmOf(over.bowlerId);
        if (isLegal) bowl.ballsBowled += 1;
        // Bowler is charged off-the-bat runs + wides/no-balls (not byes/leg-byes).
        bowl.runsConceded += ball.runs + (isWideNoBall ? extraRuns : 0);

        if (ball.dismissal) {
          bat.dismissed = true;
          const type = ball.dismissal.type;
          if (BOWLER_CREDIT.has(type)) bowl.wickets += 1;
          if (type === "caught") {
            const ids = ball.dismissal.fielderIds ??
              (ball.dismissal.fielderId ? [ball.dismissal.fielderId] : []);
            for (const fid of ids) pmOf(fid).catches += 1;
          } else if (type === "stumped") {
            const ids = ball.dismissal.fielderIds ??
              (ball.dismissal.fielderId ? [ball.dismissal.fielderId] : []);
            for (const fid of ids) pmOf(fid).stumpings += 1;
          } else if (type === "run-out") {
            const ids = ball.dismissal.fielderIds ??
              (ball.dismissal.fielderId ? [ball.dismissal.fielderId] : []);
            for (const fid of ids) pmOf(fid).runOuts += 1;
          }
        }

        // Non-dismissal fielding events (great stop, drop, misfield, …) credited to fielder(s).
        if (ball.fielding?.eventLabel) {
          const label = ball.fielding.eventLabel;
          const pts = fePoints.get(label) ?? 0;
          const ids = ball.fielding.fielderIds ??
            (ball.fielding.fielderId ? [ball.fielding.fielderId] : []);
          for (const fid of ids) {
            const f = pmOf(fid);
            f.fieldingEvents[label] = (f.fieldingEvents[label] ?? 0) + 1;
            f.fieldingPoints += pts;
          }
        }
      }
    }

    // Winner: map innings → team via the same toss logic the app uses, then
    // compare innings totals. homeTeam == teamA, awayTeam == teamB.
    const t1 = inningsTotal["innings-1"] ?? 0;
    const t2 = inningsTotal["innings-2"] ?? 0;
    const tossWinnerBats =
      (toss?.winnerId === "homeTeam" && toss?.choice === "bat") ||
      (toss?.winnerId === "awayTeam" && toss?.choice === "field");
    const battingFirst: "A" | "B" = toss ? (tossWinnerBats ? "A" : "B") : "A";
    const battingSecond: "A" | "B" = battingFirst === "A" ? "B" : "A";
    const winnerTeam: "A" | "B" | "tie" =
      t1 > t2 ? battingFirst : t2 > t1 ? battingSecond : "tie";
    const resultForTeam = (team: "A" | "B"): "win" | "loss" | "tie" =>
      winnerTeam === "tie" ? "tie" : winnerTeam === team ? "win" : "loss";

    const played = Array.from(new Set([...teamA, ...teamB]));
    if (played.length === 0) {
      await matchRef.update({winnerTeam, statsAggregated: true});
      return;
    }

    // Read current high scores (highScore is a max, not a sum).
    const playerRefs = played.map((id) =>
      db.collection("clubs").doc(clubId).collection("players").doc(id),
    );
    const snaps = await db.getAll(...playerRefs);
    const careerHS = new Map<string, number>();
    const captainHS = new Map<string, number>();
    const careerFE = new Map<string, Record<string, number>>();
    for (const snap of snaps) {
      const data = snap.data() ?? {};
      careerHS.set(snap.id, data.careerStats?.highScore ?? 0);
      captainHS.set(snap.id, data.captainStats?.highScore ?? 0);
      careerFE.set(snap.id, data.careerStats?.fieldingEventCounts ?? {});
    }

    // One merged update per player (Firestore forbids 2 writes to a doc per batch).
    const updatesById = new Map<string, FsUpdate>();
    const ensure = (id: string): FsUpdate => {
      let u = updatesById.get(id);
      if (!u) {
        u = {}; updatesById.set(id, u);
      }
      return u;
    };

    for (const id of played) {
      const m = pm.get(id) ?? emptyPM();
      const u = ensure(id);
      u["careerStats.matchesPlayed"] = FieldValue.increment(1);
      u["careerStats.totalRuns"] = FieldValue.increment(m.battingRuns);
      u["careerStats.totalBallsFaced"] = FieldValue.increment(m.ballsFaced);
      u["careerStats.totalDismissals"] = FieldValue.increment(m.dismissed ? 1 : 0);
      u["careerStats.totalBallsBowled"] = FieldValue.increment(m.ballsBowled);
      u["careerStats.totalRunsConceded"] = FieldValue.increment(m.runsConceded);
      u["careerStats.totalWickets"] = FieldValue.increment(m.wickets);
      u["careerStats.totalCatches"] = FieldValue.increment(m.catches);
      u["careerStats.totalRunOuts"] = FieldValue.increment(m.runOuts);
      u["careerStats.totalStumpings"] = FieldValue.increment(m.stumpings);
      if (m.fieldingPoints !== 0) {
        u["careerStats.fieldingPoints"] = FieldValue.increment(m.fieldingPoints);
      }
      if (m.battingRuns > (careerHS.get(id) ?? 0)) {
        u["careerStats.highScore"] = m.battingRuns;
      }
      // Merge this match's fielding-event counts into the stored map. Labels are
      // map keys (not field paths), so spaces/dots in labels are safe.
      const events = Object.entries(m.fieldingEvents);
      if (events.length > 0) {
        const merged: Record<string, number> = {...(careerFE.get(id) ?? {})};
        for (const [label, count] of events) merged[label] = (merged[label] ?? 0) + count;
        u["careerStats.fieldingEventCounts"] = merged;
      }

      // Wagon wheel stored as a map { sector → runs } so each sector increments
      // independently (numeric keys are safe field paths). getBattingInsights
      // normalises this back into a 12-length array for the client.
      m.wagon.forEach((runs, sector) => {
        if (runs > 0) {
          u[`careerStats.wagonWheel.${sector}`] = FieldValue.increment(runs);
        }
      });
    }

    const applyCaptain = (capId: string | undefined, team: "A" | "B") => {
      if (!capId) return;
      const m = pm.get(capId) ?? emptyPM();
      const r = resultForTeam(team);
      const u = ensure(capId);
      u["captainStats.matches"] = FieldValue.increment(1);
      u["captainStats.wins"] = FieldValue.increment(r === "win" ? 1 : 0);
      u["captainStats.losses"] = FieldValue.increment(r === "loss" ? 1 : 0);
      u["captainStats.ties"] = FieldValue.increment(r === "tie" ? 1 : 0);
      u["captainStats.runs"] = FieldValue.increment(m.battingRuns);
      u["captainStats.ballsFaced"] = FieldValue.increment(m.ballsFaced);
      u["captainStats.dismissals"] = FieldValue.increment(m.dismissed ? 1 : 0);
      u["captainStats.ballsBowled"] = FieldValue.increment(m.ballsBowled);
      u["captainStats.runsConceded"] = FieldValue.increment(m.runsConceded);
      u["captainStats.wickets"] = FieldValue.increment(m.wickets);
      if (m.battingRuns > (captainHS.get(capId) ?? 0)) {
        u["captainStats.highScore"] = m.battingRuns;
      }
    };
    applyCaptain(captainA, "A");
    applyCaptain(captainB, "B");

    const batch = db.batch();
    for (const [id, u] of updatesById) {
      batch.update(db.collection("clubs").doc(clubId).collection("players").doc(id), u);
    }

    // Per-match performance rows powering the player profile's "Last 5" form
    // chart (queried by getPlayerForm). Deterministic id keeps re-runs idempotent.
    const createdAt = matchDate ?? FieldValue.serverTimestamp();
    for (const id of played) {
      const m = pm.get(id) ?? emptyPM();
      const opponent = teamA.includes(id) ? awayTeam : homeTeam;
      batch.set(
        db.collection("playerPerformances").doc(`${matchId}_${id}`),
        {
          clubId,
          matchId,
          playerId: id,
          opponent,
          label: opponent,
          runs: m.battingRuns,
          ballsFaced: m.ballsFaced,
          wickets: m.wickets,
          notOut: m.ballsFaced > 0 && !m.dismissed,
          createdAt,
        },
      );
    }

    batch.update(matchRef, {winnerTeam, statsAggregated: true});
    await batch.commit();
  },
);
