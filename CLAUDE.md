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
    matches/   ← onMatchCompleted, onMatchLive, onMatchAbandoned (Firestore triggers)
    players/   ← linkGhost, unlinkGhost, mirrorPlayerStats
    clubs/     ← resolveJoinRequest, onJoinRequestCreated, syncClubNameArchived, cleanupArchivedClubs,
                 leaveClub, removeMember
    imports/   ← onStatsImport (Storage trigger)
    tools/     ← AI data tools (one callable per file)
    apiKeys/   ← generateApiKey
  services/
    statsResolver.ts    ← resolves player stats with claim preview
    fuzzyMatcher.ts     ← name matching for ghost linking
    apiKeyAuth.ts       ← SHA-256 key verification with in-memory cache
    firebaseAuth.ts     ← assertClubMember, assertAdmin helpers
    mergeCareerStats.ts ← addCareerStats / subtractCareerStats (exact inverses)
    pushNotifications.ts ← sendPushToUsers / notifyRegisteredMembers (Expo push, chunked + token pruning)
    membership.ts       ← deactivatePlayer (leave/remove — shared by leaveClub, removeMember)
  utils/
    statsCalculator.ts  ← computeSkillRating
  types/index.ts        ← NOT a faithful mirror of the app repo's types (e.g. `Match` here uses
                           homeTeamId/awayTeamId and lacks scorerId) — existing code reads
                           Firestore data via untyped `snap.data()` + inline casts rather than this
                           interface. Only `PushNotificationData` here is a genuine, kept-in-sync
                           shared contract with the app repo's identically-named type.

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
| `onMatchCompleted` | `clubs/{clubId}/matches/{matchId}` updated | When status → **completed only** (never fires for 'abandoned' — see `onMatchAbandoned`): aggregates career stats (batting, bowling, fielding), wagon wheel, fieldingPoints from all overs. Writes to `clubs/{clubId}/players/{playerId}.careerStats` via batch, then sends the "match finished" push notification (from both its normal exit and its empty-squad early-return path). |
| `onMatchLive` | `clubs/{clubId}/matches/{matchId}` written | When status transitions to 'live' (create-as-live or 'scheduled'→'live' update — guarded so it never re-fires on a later write to an already-live match): sends the "match started" push notification to registered members, minus the scorer. |
| `onMatchAbandoned` | `clubs/{clubId}/matches/{matchId}` updated | When status transitions to 'abandoned': sends the "match finished" push notification to registered members, minus the scorer. No stats logic — kept separate from `onMatchCompleted` on purpose. |
| `mirrorPlayerStats` | `clubs/{clubId}/players/{playerId}` written | Copies public-safe fields to `publicPlayerStats/{uid}_{clubId}` so any signed-in user can read stats without club membership. |
| `syncClubNameArchived` | `clubs/{clubId}` written | Propagates club name / archived flag changes to member player docs. |
| `onJoinRequestCreated` | `clubs/{clubId}/joinRequests/{requesterUid}` created | Sends a push notification to every admin of the club (per-club `role==='admin'`, not a global admins list). |

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
- `resolveJoinRequest` — approves/rejects a club join request; optionally links a ghost (`linkGhostId`); on approval, also sends the "join approved" push notification to the requester; **also auto-reactivates a departed member's own doc on approval** (same uid rejoining — see "Leave club / remove member" below)
- `leaveClub` — self-service: `type:'registered'` → `type:'ghost', status:'departed'`, careerStats untouched. Transactional last-admin guard.
- `removeMember` — admin-only equivalent of `leaveClub` for a different member. Same last-admin guard (closes a concurrent-removal race, not just the single-caller case).
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

## Leave club / remove member (IMPLEMENTED)
`services/membership.ts`'s `deactivatePlayer(db, clubId, playerId, tx?)` is the shared
end-state for both `leaveClub` and `removeMember`: `type:'registered'` → `type:'ghost'`,
`status:'departed'`, `departedAt` server timestamp, `role` reset to `'member'`.
**`careerStats` is never read or written** — the same doc (id = the player's uid) just goes
dormant, so a same-uid rejoin has the exact stats waiting, untouched.

- Both callables run their last-admin guard **inside** the transaction that also does the
  write (query: `type=='registered' && role=='admin'`, block if count would hit zero) — not
  as a separate pre-check, since that would leave a TOCTOU window for two admins
  leaving/removing concurrently. Firestore's transaction conflict detection forces a retry
  when the admin-count query's result set changed since the read, so the second transaction
  correctly sees the post-write count and fails the guard.
- `removeMember` additionally rejects `playerId === callerUid` (must use `leaveClub`) and
  guards the SAME concurrent-race case even though caller≠target — two different admins
  removing each other simultaneously would otherwise each independently pass their own
  "am I admin" check.
- `resolveJoinRequest`'s approve path detects `existingPlayer.data().type === 'ghost'` at the
  requester's own doc (doc id is always their uid) and reactivates it directly — `status`/
  `departedAt` cleared via `FieldValue.delete()`, `careerStats` left completely untouched, no
  `linkGhostId` accepted alongside (rejected with a clear error — the ghost read/merge path is
  skipped entirely for this branch, since merging the same doc into itself would double-write
  it within one transaction).
- `getClubGhosts` (app repo), `linkGhost.ts` (server-side, defense-in-depth) both reject
  `status:'departed'` ghosts — a departed member's doc is `type:'ghost'` like any other ghost,
  so without this a departed member could be picked from an admin's "link to member" picker
  and merged into someone ELSE, corrupting stats and permanently blocking their own
  reactivation (the self-reactivation path above only fires for an *unlinked* ghost sitting at
  the requester's own uid).
- `firestore.rules`' `isMember(clubId)` requires `type == 'registered'` (not just doc
  existence) — a departed member's doc is never deleted, so existence-only would let them
  silently keep read (and, via `isAdmin`, write) access to the club forever.

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

## Push notifications
`services/pushNotifications.ts` — `sendPushToUsers` (chunked Expo sends via `expo-server-sdk`
**v5**, deliberately not v6+, which is ESM-only and would break this repo's CommonJS output
since `functions/package.json` has no `"type":"module"`; per-chunk ticket pruning removes
`DeviceNotRegistered` tokens from the owning `users/{uid}.expoPushTokens`) and
`notifyRegisteredMembers` (queries `clubs/{clubId}/players` where `type=='registered'`,
delegates to `sendPushToUsers` with `requireMatchPref: true`).

Only match-live/match-finished sends pass `requireMatchPref: true` (respects
`users/{uid}.notificationPrefs.matchNotifications`, default on) — join-request/approval
sends never gate on it, always sending regardless. All four trigger functions wrap their
send in try/catch and never let a notification failure affect already-committed data;
none currently de-dup against Cloud Functions' at-least-once delivery, so a redelivered
event could in rare cases send the same push twice.

## Deploy
```
cd functions && firebase deploy --only functions
```
Lint + build (`tsc`) run as predeploy scripts. All 22 functions deploy together.
