# Cricket Scorer — Cloud Functions

## Stack
Node.js 20, TypeScript strict, Firebase Admin SDK v12,
Google Cloud Tasks, fastest-levenshtein, pdf-parse.

## Folder structure
src/
  functions/
    claims/       ← initiateClaim, mergeClaim, revertClaim, resolveContest
    imports/      ← onStatsImport (PDF/CSV → ghost players)
    matches/      ← onMatchStarted (freezes rules snapshot), onOverCompleted
    tools/        ← AI data tools (one file per tool)
    apiKeys/      ← generateApiKey
  services/
    statsResolver.ts
    fuzzyMatcher.ts
    apiKeyAuth.ts
    firebaseAuth.ts
  utils/
    statsCalculator.ts
  types/index.ts  ← identical to app repo types

## Absolute rules
- ALL functions deploy to australia-southeast1
- ALL stat writes use batch or transaction — never single writes
- FieldValue.increment() only — never read-modify-write
- mergeClaim Cloud Task checks claim.status === 'cooldown' before acting (idempotent)
- NO `any` types

## Stats rules
- mergeStatsFromTotals() and subtractStats() are exact inverses
- Store only additive totals — NEVER store averages/economy/SR in Firestore
- Ghost stats: always from claim.snapshot.ghostStats
- Registered stats: always read live at merge time
- CareerStats fields: totalRuns, totalWickets, totalBallsFaced, totalDismissals,
  totalBallsBowled, totalRunsConceded, totalCatches, totalRunOuts, highScore, matchesPlayed

## Claim guards (initiateClaim — all in one transaction)
1. Claimant already has activeClaim → reject
2. Ghost is linked (playerType === 'linked') → reject
3. Ghost claimStatus === 'open' → start cooldown, schedule Cloud Task
4. Ghost claimStatus === 'cooldown' → queue as waiting, mark both contested,
   cancel auto-merge Cloud Task, notify admin
5. Ghost claimStatus === 'contested' → reject

## AI tools (data fetch only — no reasoning)
Each tool is an onCall function.
Each enforces assertClubMember(uid, clubId) before any data access.
Tools return raw data — no balancing, no suggestions, no computed teams.

## Fuzzy matching
fastest-levenshtein + initials matching + surname bonus
Thresholds: ≥0.90 auto-suggest · ≥0.75 admin queue · <0.75 hidden

## API key auth
SHA-256 hash stored in /apiKeys/{id} — raw key never stored
In-memory cache 5 min TTL
Update lastUsedAt async (don't await)

## match.rules snapshot
onMatchStarted copies club.rules → match.rules when match status → 'live'
Scoring engine always reads match.rules — never club.rules directly
