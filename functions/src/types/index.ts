export type PlayerType = "ghost" | "linked" | "registered";
export type ClaimStatus = "open" | "cooldown" | "contested" | "merged" | "rejected";
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

export interface GhostPlayer {
  id: string;
  clubId: string;
  rawName: string;
  playerType: PlayerType;
  claimStatus: ClaimStatus;
  activeClaim?: string;
  careerStats: CareerStats;
  fuzzyMatchScore?: number;
  fuzzyMatchCandidates?: FuzzyCandidate[];
}

export interface RegisteredPlayer {
  id: string;
  clubId: string;
  displayName: string;
  careerStats: CareerStats;
  activeClaim?: string;
}

export interface FuzzyCandidate {
  playerId: string;
  displayName: string;
  score: number;
}

export interface ClaimSnapshot {
  ghostStats: CareerStats;
  registeredStats: CareerStats;
  mergedStats: CareerStats;
}

export interface Claim {
  id: string;
  clubId: string;
  ghostPlayerId: string;
  claimantUid: string;
  registeredPlayerId: string;
  status: ClaimStatus;
  snapshot: ClaimSnapshot;
  cooldownEndsAt?: FirebaseFirestore.Timestamp;
  cloudTaskName?: string;
  contestedByClaimId?: string;
  waitingClaimId?: string;
  createdAt: FirebaseFirestore.Timestamp;
  updatedAt: FirebaseFirestore.Timestamp;
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
