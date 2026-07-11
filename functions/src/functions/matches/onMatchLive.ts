import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {notifyRegisteredMembers} from "../../services/pushNotifications.js";

const REGION = "australia-southeast1";

/**
 * Notifies every registered club member (minus the scorer) when a match goes
 * live, with a link to the live score. Matches are usually created ALREADY
 * live (createLiveMatch sets status:'live' directly on setDoc, no separate
 * 'scheduled' stage) but the legacy edit-mode path (setMatchToss) can still
 * transition an existing 'scheduled' doc to 'live' via updateDoc — the guard
 * below catches both the create (no `before`) and update cases, and must NOT
 * re-fire on every subsequent write to an already-live match (substitutes,
 * endFirstInnings, updateMatchOvers, toss patches all updateDoc the same doc).
 */
export const onMatchLive = onDocumentWritten(
  {document: "clubs/{clubId}/matches/{matchId}", region: REGION},
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!after || after.status !== "live") return;
    if (before && before.status === "live") return;

    const clubId = event.params.clubId as string;
    const matchId = event.params.matchId as string;
    const homeTeam = (after.homeTeam as string | undefined) ?? "Home";
    const awayTeam = (after.awayTeam as string | undefined) ?? "Away";
    const scorerId = after.scorerId as string | undefined;

    try {
      await notifyRegisteredMembers({
        clubId,
        excludeUid: scorerId,
        title: "Match started",
        body: `${homeTeam} vs ${awayTeam} is live`,
        data: {type: "match_live", clubId, matchId},
      });
    } catch (err) {
      console.error("[onMatchLive] notification failed", err);
    }
  },
);
