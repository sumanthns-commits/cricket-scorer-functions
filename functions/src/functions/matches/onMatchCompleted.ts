import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const REGION = "australia-southeast1";

interface OverDelivery {
  batsmanId: string;
  bowlerId: string;
  runs: number;
  extras: number;
  wicket?: { type: string; fielderId?: string; fielderIds?: string[] };
  isWide?: boolean;
  isNoBall?: boolean;
}

interface OverDoc {
  inningsNumber: number;
  overNumber: number;
  battingTeamId: string;
  deliveries: OverDelivery[];
  sealed: boolean;
}

interface BatsmanState {
  runs: number;
  balls: number;
  overEnteredAt: number;
  battingPosition: number;
  dismissed: boolean;
  dismissal?: { type: string; bowlerId?: string; overNumber: number };
}

interface BowlerState {
  overNumbers: number[];
  totalBalls: number;
  totalRuns: number;
  wickets: number;
}

interface PlayerMatchData {
  teamId: string;
  batting?: {
    runs: number;
    balls: number;
    battingPosition: number;
    overEnteredAt: number;
    overProgressWhenCameIn: number;
    notOut: boolean;
    dismissal?: { type: string; bowlerId?: string; overNumber: number };
  };
  bowling?: {
    overNumbers: number[];
    firstOverProgress: number;
    totalBalls: number;
    totalRuns: number;
    wickets: number;
  };
}

function matchResultForTeam(
  winnerId: string | null | undefined,
  teamId: string,
): "win" | "loss" | "tie" | "noResult" {
  if (winnerId === "tie") return "tie";
  if (!winnerId) return "noResult";
  return winnerId === teamId ? "win" : "loss";
}

export const onMatchCompleted = onDocumentUpdated(
  { document: "matches/{matchId}", region: REGION },
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();

    if (!after || after.status !== "completed" || before?.status === "completed") return;

    const matchId = event.params.matchId;
    const clubId = after.clubId as string | undefined;
    const homeTeamId = after.homeTeamId as string;
    const awayTeamId = after.awayTeamId as string;
    const winnerId = after.winnerId as string | null | undefined;
    const matchDate = after.createdAt;

    if (!clubId) return;

    const db = getFirestore();

    const oversSnap = await db
      .collection("matches").doc(matchId).collection("overs")
      .where("sealed", "==", true)
      .orderBy("inningsNumber")
      .orderBy("overNumber")
      .get();

    // Group overs by innings
    const inningsOvers = new Map<number, OverDoc[]>();
    for (const doc of oversSnap.docs) {
      const o = doc.data() as OverDoc;
      if (!inningsOvers.has(o.inningsNumber)) inningsOvers.set(o.inningsNumber, []);
      inningsOvers.get(o.inningsNumber)!.push(o);
    }

    const playerData = new Map<string, PlayerMatchData>();

    const getOrInit = (playerId: string, teamId: string): PlayerMatchData => {
      if (!playerData.has(playerId)) playerData.set(playerId, { teamId });
      return playerData.get(playerId)!;
    };

    for (const [, overs] of inningsOvers) {
      if (overs.length === 0) continue;

      const battingTeamId = overs[0].battingTeamId;
      const bowlingTeamId = battingTeamId === homeTeamId ? awayTeamId : homeTeamId;
      const totalOvers = overs[overs.length - 1].overNumber;

      const batsmanStates = new Map<string, BatsmanState>();
      const battingOrder: string[] = [];
      const bowlerStates = new Map<string, BowlerState>();

      for (const over of overs) {
        const overNumber = over.overNumber;
        let prevBowlerState = bowlerStates.get(over.deliveries[0]?.bowlerId ?? "");

        for (const d of over.deliveries) {
          const isLegal = !d.isWide && !d.isNoBall;

          // Track batting entry
          if (!batsmanStates.has(d.batsmanId)) {
            battingOrder.push(d.batsmanId);
            batsmanStates.set(d.batsmanId, {
              runs: 0,
              balls: 0,
              overEnteredAt: overNumber,
              battingPosition: battingOrder.length,
              dismissed: false,
            });
          }

          const bs = batsmanStates.get(d.batsmanId)!;
          bs.runs += d.runs;
          if (isLegal) bs.balls += 1;

          // Track bowling
          if (!bowlerStates.has(d.bowlerId)) {
            bowlerStates.set(d.bowlerId, { overNumbers: [], totalBalls: 0, totalRuns: 0, wickets: 0 });
          }
          const bowl = bowlerStates.get(d.bowlerId)!;
          if (bowl.overNumbers[bowl.overNumbers.length - 1] !== overNumber) {
            bowl.overNumbers.push(overNumber);
          }
          if (isLegal) bowl.totalBalls += 1;
          bowl.totalRuns += d.runs + d.extras;

          if (d.wicket) {
            bs.dismissed = true;
            const isBowlerWicket = d.wicket.type !== "runOut";
            if (isBowlerWicket) bowl.wickets += 1;
            bs.dismissal = {
              type: d.wicket.type,
              bowlerId: isBowlerWicket ? d.bowlerId : undefined,
              overNumber,
            };
          }

          prevBowlerState = bowl;
        }

        // suppress unused warning
        void prevBowlerState;
      }

      // Commit batting data per player
      for (const [playerId, bs] of batsmanStates) {
        const pd = getOrInit(playerId, battingTeamId);
        pd.batting = {
          runs: bs.runs,
          balls: bs.balls,
          battingPosition: bs.battingPosition,
          overEnteredAt: bs.overEnteredAt,
          overProgressWhenCameIn: bs.overEnteredAt / totalOvers,
          notOut: !bs.dismissed,
          ...(bs.dismissal ? { dismissal: bs.dismissal } : {}),
        };
      }

      // Commit bowling data per player
      for (const [playerId, bowl] of bowlerStates) {
        const pd = getOrInit(playerId, bowlingTeamId);
        pd.bowling = {
          overNumbers: bowl.overNumbers,
          firstOverProgress: bowl.overNumbers[0] / totalOvers,
          totalBalls: bowl.totalBalls,
          totalRuns: bowl.totalRuns,
          wickets: bowl.wickets,
        };
      }
    }

    // Write matchIndex docs + pre-aggregate batting position stats
    const batch = db.batch();

    for (const [playerId, pd] of playerData) {
      const matchResult = matchResultForTeam(winnerId, pd.teamId);

      // matchIndex document
      const matchIndexRef = db
        .collection("clubs").doc(clubId)
        .collection("players").doc(playerId)
        .collection("matchIndex").doc(matchId);

      batch.set(matchIndexRef, {
        matchId,
        clubId,
        matchDate,
        teamId: pd.teamId,
        matchResult,
        ...(pd.batting ? { batting: pd.batting } : {}),
        ...(pd.bowling ? { bowling: pd.bowling } : {}),
      });

      // Pre-aggregate batting position stats for fast "best position" reads
      if (pd.batting) {
        const pos = pd.batting.battingPosition;
        const playerRef = db
          .collection("clubs").doc(clubId)
          .collection("players").doc(playerId);

        const posUpdates: Record<string, FirebaseFirestore.FieldValue> = {
          [`battingPositionStats.p${pos}.innings`]: FieldValue.increment(1),
          [`battingPositionStats.p${pos}.runs`]: FieldValue.increment(pd.batting.runs),
        };
        if (!pd.batting.notOut) {
          posUpdates[`battingPositionStats.p${pos}.dismissals`] = FieldValue.increment(1);
        }
        if (matchResult === "win") {
          posUpdates[`battingPositionStats.p${pos}.wins`] = FieldValue.increment(1);
        }
        batch.update(playerRef, posUpdates);
      }
    }

    await batch.commit();
  },
);
