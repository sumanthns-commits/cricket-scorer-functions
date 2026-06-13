import type {CareerStats} from "../types/index.js";

export function computeSkillRating(stats: CareerStats): number {
  const battingAvg =
    stats.totalDismissals > 0 ?
      stats.totalRuns / stats.totalDismissals :
      stats.totalRuns;

  const strikeRate =
    stats.totalBallsFaced > 0 ?
      (stats.totalRuns / stats.totalBallsFaced) * 100 :
      0;

  const economy =
    stats.totalBallsBowled > 0 ?
      (stats.totalRunsConceded / stats.totalBallsBowled) * 6 :
      0;

  const wicketContrib = stats.totalWickets * 20;
  // Dismissals credited to a fielder/keeper, plus net points from non-dismissal
  // fielding events (great stops add, drops/misfields subtract).
  const catchContrib =
    (stats.totalCatches + stats.totalRunOuts + (stats.totalStumpings ?? 0)) * 5 +
    (stats.fieldingPoints ?? 0);

  const battingScore = battingAvg * 0.4 + strikeRate * 0.1;
  const bowlingScore = economy > 0 ? Math.max(0, (12 - economy) * 5) : 0;

  return Math.round(battingScore + bowlingScore + wicketContrib + catchContrib);
}
