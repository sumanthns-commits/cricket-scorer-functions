import type { CareerStats } from "../types/index.js";

export function mergeStatsFromTotals(ghost: CareerStats, registered: CareerStats): CareerStats {
  return {
    totalRuns: ghost.totalRuns + registered.totalRuns,
    totalWickets: ghost.totalWickets + registered.totalWickets,
    totalBallsFaced: ghost.totalBallsFaced + registered.totalBallsFaced,
    totalDismissals: ghost.totalDismissals + registered.totalDismissals,
    totalBallsBowled: ghost.totalBallsBowled + registered.totalBallsBowled,
    totalRunsConceded: ghost.totalRunsConceded + registered.totalRunsConceded,
    totalCatches: ghost.totalCatches + registered.totalCatches,
    totalRunOuts: ghost.totalRunOuts + registered.totalRunOuts,
    highScore: Math.max(ghost.highScore, registered.highScore),
    matchesPlayed: ghost.matchesPlayed + registered.matchesPlayed,
  };
}

export function subtractStats(merged: CareerStats, ghost: CareerStats): CareerStats {
  return {
    totalRuns: merged.totalRuns - ghost.totalRuns,
    totalWickets: merged.totalWickets - ghost.totalWickets,
    totalBallsFaced: merged.totalBallsFaced - ghost.totalBallsFaced,
    totalDismissals: merged.totalDismissals - ghost.totalDismissals,
    totalBallsBowled: merged.totalBallsBowled - ghost.totalBallsBowled,
    totalRunsConceded: merged.totalRunsConceded - ghost.totalRunsConceded,
    totalCatches: merged.totalCatches - ghost.totalCatches,
    totalRunOuts: merged.totalRunOuts - ghost.totalRunOuts,
    highScore: merged.highScore,
    matchesPlayed: merged.matchesPlayed - ghost.matchesPlayed,
  };
}

export function computeSkillRating(stats: CareerStats): number {
  const battingAvg =
    stats.totalDismissals > 0
      ? stats.totalRuns / stats.totalDismissals
      : stats.totalRuns;

  const strikeRate =
    stats.totalBallsFaced > 0
      ? (stats.totalRuns / stats.totalBallsFaced) * 100
      : 0;

  const economy =
    stats.totalBallsBowled > 0
      ? (stats.totalRunsConceded / stats.totalBallsBowled) * 6
      : 0;

  const wicketContrib = stats.totalWickets * 20;
  const catchContrib = (stats.totalCatches + stats.totalRunOuts) * 5;

  const battingScore = battingAvg * 0.4 + strikeRate * 0.1;
  const bowlingScore = economy > 0 ? Math.max(0, (12 - economy) * 5) : 0;

  return Math.round(battingScore + bowlingScore + wicketContrib + catchContrib);
}
