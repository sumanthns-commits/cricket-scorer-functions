# Cricket Scorer — Cloud Functions

## What this is
Firebase Cloud Functions (Gen 2, Node 24, TypeScript strict) backing the Cricket Scorer
mobile app. All functions deploy to `australia-southeast1`.
Companion app repo: `../cricket-scorer-app`

## Stack
- Firebase Admin SDK v12, Firebase Functions v2
- `fastest-levenshtein` for fuzzy name matching
- `pdf-parse` for PDF stat imports

## Folder structure
functions/src/
  functions/
    matches/   ← onMatchCompleted (Firestore trigger)
    players/   ← linkGhost, unlinkGhost, mirrorPlayerStats
    clubs/     ← resolveJoinRequest, syncClubNameArchived, cleanupArchivedClubs
    imports/   ← onStatsImport (Storage trigger)
    tools/     ← AI data tools (one callable per file)
    apiKeys/   ← generateApiKey
  services/
    statsResolver.ts    ← resolves player stats with claim preview
    fuzzyMatcher.ts     ← name matching for ghost linking
    apiKeyAuth.ts       ← SHA-256 key verification with in-memory cache
    firebaseAuth.ts     ← assertClubMember, assertAdmin helpers
    mergeCareerStats.ts ← addCareerStats / subtractCareerStats (exact inverses)
  utils/
    statsCalculator.ts  ← computeSkillRating
  types/index.ts        ← mirrors app repo types

## Absolute rules
- ALL functions deploy to `australia-southeast1` (REGION constant)
- ALL stat writes use batch or transaction — never isolated single writes
- `FieldValue.increment()` only — NEVER read-modify-write on counters
- Store only additive totals — NEVER store averages / economy / SR in Firestore
- NO `any` types

## Function catalogue

### Firestore triggers
| Function | Trigger path | What it does |
|---|---|---|
| `onMatchCompleted` | `clubs/{clubId}/matches/{matchId}` updated | When status → completed/abandoned: aggregates career stats (batting, bowling, fielding), wagon wheel, fieldingPoints from all overs. Writes to `clubs/{clubId}/players/{playerId}.careerStats` via batch. |
| `mirrorPlayerStats` | `clubs/{clubId}/players/{playerId}` written | Copies public-safe fields to `publicPlayerStats/{uid}_{clubId}` so any signed-in user can read stats without club membership. |
| `syncClubNameArchived` | `clubs/{clubId}` written | Propagates club name / archived flag changes to member player docs. |

### Storage trigger
| Function | Trigger | What it does |
|---|---|---|
| `onStatsImport` | Object finalised at `imports/{clubId}/{filename}` | Parses PDF/CSV of historic stats → creates/updates ghost player docs in `clubs/{clubId}/players/`. Uses fuzzy matching to avoid duplicates. |

### Scheduled
| Function | Schedule | What it does |
|---|---|---|
| `cleanupArchivedClubs` | Every 24 h (Australia/Sydney) | Deletes data for clubs archived beyond retention period. |

### Callables (onCall, invoker: "public")
**Player / ghost management**
- `linkGhost` — admin merges a ghost into a registered member; calls `addCareerStats`, sets `type:'linked'`
- `unlinkGhost` — reverses the above; calls `subtractCareerStats`, restores `type:'ghost'`
- `resolveJoinRequest` — approves/rejects a club join request; optionally links a ghost (`linkGhostId`)
- `generateApiKey` — creates a SHA-256 hashed API key for a club

**AI data tools** (all enforce `assertClubMember` before any read; return raw data only)
- `getAvailablePlayers` — squad minus linked ghosts
- `getPlayerStats` — career stats for a player
- `getPlayerForm` — recent match performances
- `getBattingInsights` — aggregated batting breakdown
- `getBowlingInsights` — aggregated bowling breakdown
- `getHeadToHead` — head-to-head between two players
- `getMatchContext` — match rules, teams, toss for AI context
- `getClubPlayerStats` — all players' stats for a club

## onMatchCompleted — stats aggregation detail

**Fielding credits per ball:**
- `dismissal.type === 'caught'` → `fielderId` gets `totalCatches++`
- `dismissal.type === 'stumped'` → `fielderId` gets `totalStumpings++`
- `dismissal.type === 'run-out'` → all IDs in `fielderIds ?? [fielderId]` get `totalRunOuts++`
- Non-dismissal events: all IDs in `fielding.fielderIds ?? [fielding.fielderId]` get
  `fieldingEvents[label]++` and `fieldingPoints += POLARITY_POINTS[polarity]`
  (`+3` positive / `-3` negative / `0` neutral). Points frozen at completion.

**Fielding rating:** `computeSkillRating` = `(catches + runOuts + stumpings) × 5 + fieldingPoints`

**Wagon wheel:** stored as `careerStats.wagonWheel[sector]` (sector 0–11, keyed as strings).

**match.rules snapshot:** `onMatchCompleted` reads `match.rules` (snapshotted at match creation via
the app's `createMatch`) for fielding event polarity — immune to later club rule edits.

## Stats utils

`mergeCareerStats.ts`
- `addCareerStats(base, delta)` — merge ghost stats into member
- `subtractCareerStats(base, delta)` — reverse a ghost link (exact inverse)
- Both handle nested maps: `fieldingEventCounts`, `wagonWheel` merged key-by-key

`statsCalculator.ts`
- `computeSkillRating(stats)` — composite score used for AI team selection and leaderboards

## Ghost linking (IMPLEMENTED)
Admin flow via `resolveJoinRequest({ linkGhostId })` or direct `linkGhost` callable:
1. `addCareerStats` folds ghost's careerStats into member's per-club doc (no cooldown)
2. Ghost doc → `type:'linked'`, `linkedTo: uid`; member gets `linkedGhost` pointer
3. `mirrorPlayerStats` trigger propagates merged stats to `publicPlayerStats`
4. Reversible: `unlinkGhost` → `subtractCareerStats`, restores `type:'ghost'`

## Self-service claim lifecycle (PLANNED — NOT implemented)
No claim functions exist. `statsResolver` only previews what a claim snapshot would show.
The `claims/` folder does not exist — do not create claim functions without explicit instruction.

## Auth guards
- `assertClubMember(uid, clubId)` — throws `permission-denied` if not a member
- `assertAdmin(uid, clubId)` — throws `permission-denied` if not an admin
- API keys: SHA-256 hash in `/apiKeys/{id}`; raw key never stored; 5-min in-memory cache TTL

## Fuzzy matching (onStatsImport)
`fastest-levenshtein` + initials matching + surname bonus.
Thresholds: ≥ 0.90 auto-suggest · ≥ 0.75 admin queue · < 0.75 hidden

## publicPlayerStats mirror
Path: `publicPlayerStats/{uid}_{clubId}`
Any authenticated user can read — used by non-members viewing scorecards/profiles.
Written by `mirrorPlayerStats` trigger on every `clubs/{clubId}/players/{uid}` write.

## Deploy
```
cd functions && firebase deploy --only functions
```
Lint + build (`tsc`) run as predeploy scripts. All 17 functions deploy together.
