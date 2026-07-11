import {onDocumentUpdated} from "firebase-functions/v2/firestore";
import {notifyRegisteredMembers} from "../../services/pushNotifications.js";

const REGION = "australia-southeast1";

/**
 * Notifies registered members when a match is abandoned, minus the scorer.
 * Kept separate from onMatchCompleted (which only fires for status ===
 * 'completed', never 'abandoned' — abandonMatch() never sets
 * statsAggregated, so no stats logic applies here) so this pure-notification
 * trigger can't affect the tested stats-aggregation path.
 */
export const onMatchAbandoned = onDocumentUpdated(
  {document: "clubs/{clubId}/matches/{matchId}", region: REGION},
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (after.status !== "abandoned" || before.status === "abandoned") return;

    const clubId = event.params.clubId as string;
    const matchId = event.params.matchId as string;
    const homeTeam = (after.homeTeam as string | undefined) ?? "Home";
    const awayTeam = (after.awayTeam as string | undefined) ?? "Away";

    try {
      await notifyRegisteredMembers({
        clubId,
        excludeUid: after.scorerId as string | undefined,
        title: "Match abandoned",
        body: `${homeTeam} vs ${awayTeam} was abandoned`,
        data: {type: "match_finished", clubId, matchId},
      });
    } catch (err) {
      console.error("[onMatchAbandoned] notification failed", err);
    }
  },
);
