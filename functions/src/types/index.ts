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
  totalStumpings: number;
  highScore: number;
  matchesPlayed: number;
  // Net rating points from non-dismissal fielding events, baked in at match
  // completion from each event's polarity (positive adds, negative subtracts).
  fieldingPoints?: number;
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

// Tap-through payload for a push notification — shared shape with the app
// repo's identically-named type (src/types/index.ts), consumed by
// notificationNavigation.ts on the client.
export type PushNotificationData =
  | { type: "join_request"; clubId: string }
  | { type: "join_approved"; clubId: string }
  | { type: "match_live"; clubId: string; matchId: string }
  | { type: "match_finished"; clubId: string; matchId: string };
