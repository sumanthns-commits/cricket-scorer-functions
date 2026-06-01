export type PlayerType = "ghost" | "registered";
export type MatchStatus = "scheduled" | "live" | "completed" | "abandoned";

export interface CareerStats {
  totalRuns: number;
  totalWickets: number;
  totalBallsFaced: number;
  totalDismissals: number;
  totalBallsBowled: number;
  totalRunsConceded: number;
  totalCatches: number;
  totalRunOuts: number;
  highScore: number;
  matchesPlayed: number;
}

export interface Player {
  id: string;
  clubId: string;
  rawName: string;
  displayName?: string;
  playerType: PlayerType;
  uid?: string;
  careerStats: CareerStats;
  fuzzyMatchScore?: number;
  fuzzyMatchCandidates?: FuzzyCandidate[];
}

export interface FuzzyCandidate {
  playerId: string;
  displayName: string;
  score: number;
}

export interface MatchRules {
  oversPerInnings: number;
  playersPerSide: number;
  maxWides: number;
  maxNoBalls: number;
  duckworthLewis: boolean;
  [key: string]: unknown;
}

export interface Match {
  id: string;
  clubId: string;
  status: MatchStatus;
  rules?: MatchRules;
  homeTeamId: string;
  awayTeamId: string;
  createdAt: FirebaseFirestore.Timestamp;
}

export interface ApiKey {
  id: string;
  clubId: string;
  hashedKey: string;
  createdBy: string;
  lastUsedAt?: FirebaseFirestore.Timestamp;
  createdAt: FirebaseFirestore.Timestamp;
}
