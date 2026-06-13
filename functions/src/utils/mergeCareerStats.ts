import type {CareerStats} from "../types/index.js";

// CareerStats plus the two map fields onMatchCompleted writes as dynamic field
// paths (careerStats.fieldingEventCounts.{label}, careerStats.wagonWheel.{sector})
// but which aren't on the base interface. Merges must preserve them.
type StatsLike = CareerStats & {
  fieldingEventCounts?: Record<string, number>;
  wagonWheel?: Record<string, number>;
};

// Plain counters that simply sum / difference. highScore (max) and the two map
// fields are handled separately.
const SUM_KEYS: (keyof CareerStats)[] = [
  "totalRuns",
  "totalWickets",
  "totalBallsFaced",
  "totalDismissals",
  "totalBallsBowled",
  "totalRunsConceded",
  "totalCatches",
  "totalRunOuts",
  "totalStumpings",
  "matchesPlayed",
  "fieldingPoints",
];

function mergeMaps(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
  sign: 1 | -1,
): Record<string, number> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, number> = {...(a ?? {})};
  for (const [k, v] of Object.entries(b ?? {})) {
    out[k] = (out[k] ?? 0) + sign * v;
    if (out[k] <= 0) delete out[k];
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function combine(base: StatsLike, delta: StatsLike, sign: 1 | -1): StatsLike {
  const out = {...base} as StatsLike;
  for (const k of SUM_KEYS) {
    const v = (base[k] ?? 0) + sign * (delta[k] ?? 0);
    out[k] = Math.max(0, v) as never;
  }
  // highScore: take the max when adding; on subtract we can't recover the true
  // pre-merge max without rescanning, so leave it (documented approximation).
  out.highScore = sign === 1 ? Math.max(base.highScore ?? 0, delta.highScore ?? 0) : base.highScore ?? 0;

  const fec = mergeMaps(base.fieldingEventCounts, delta.fieldingEventCounts, sign);
  if (fec) out.fieldingEventCounts = fec; else delete out.fieldingEventCounts;
  const ww = mergeMaps(base.wagonWheel, delta.wagonWheel, sign);
  if (ww) out.wagonWheel = ww; else delete out.wagonWheel;

  return out;
}

/** Adds `add` into `base` (counters sum, highScore = max, maps merge key-wise). */
export function addCareerStats(base: CareerStats, add: CareerStats): CareerStats {
  return combine(base as StatsLike, add as StatsLike, 1);
}

/** Reverses a prior addCareerStats(base, sub). highScore is left unchanged. */
export function subtractCareerStats(base: CareerStats, sub: CareerStats): CareerStats {
  return combine(base as StatsLike, sub as StatsLike, -1);
}
