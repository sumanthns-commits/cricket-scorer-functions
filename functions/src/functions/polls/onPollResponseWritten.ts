import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {getFirestore} from "firebase-admin/firestore";
import {logger} from "firebase-functions/v2";
import {notifyRegisteredMembers} from "../../services/pushNotifications.js";

const REGION = "australia-southeast1";

interface PollOptionData {
  id: string;
  label: string;
  schedulable?: boolean;
  minResponses?: number;
  proposedDate?: FirebaseFirestore.Timestamp;
}

function formatOptionDateTime(ts?: FirebaseFirestore.Timestamp): { day: string; time: string } {
  if (!ts) return {day: "the day", time: "the scheduled time"};
  const d = ts.toDate();
  const day = d.toLocaleDateString("en-AU", {weekday: "long"});
  const time = d.toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit", hour12: true});
  return {day, time};
}

/**
 * Fires on every create/update of a poll response. For each schedulable
 * option with a minResponses threshold that the write touched, re-checks
 * whether that option's respondent count just crossed the threshold in
 * either direction and flips optionThresholdMet accordingly — a live
 * toggle, not a one-time flag, so "Game's on!"/"Game's off!" can each fire
 * more than once if responses fluctuate across the line.
 *
 * Both the before and after doc's optionIds are considered "touched":
 * removing an option from your response (e.g. switching Sunday → Monday)
 * can drop Sunday's count below its threshold just as much as adding one
 * can raise it, even though Sunday no longer appears in the new doc.
 */
export const onPollResponseWritten = onDocumentWritten(
  {document: "clubs/{clubId}/matchPolls/{pollId}/responses/{uid}", region: REGION},
  async (event) => {
    const after = event.data?.after;
    const before = event.data?.before;
    const afterOptionIds = after?.exists ? ((after.data()?.optionIds as string[] | undefined) ?? []) : [];
    const beforeOptionIds = before?.exists ? ((before.data()?.optionIds as string[] | undefined) ?? []) : [];
    const touchedOptionIds = Array.from(new Set([...afterOptionIds, ...beforeOptionIds]));
    if (touchedOptionIds.length === 0) return;

    const clubId = event.params.clubId as string;
    const pollId = event.params.pollId as string;
    const db = getFirestore();
    const pollRef = db.collection("clubs").doc(clubId).collection("matchPolls").doc(pollId);

    // Fetched once, outside the per-option loop below — a club's name can't
    // change mid-write, and a member can belong to more than one club, so
    // every notification here needs it to say which club is on/off.
    const clubSnap = await db.collection("clubs").doc(clubId).get();
    const clubName = (clubSnap.data()?.name as string | undefined) ?? "Your club";

    for (const optionId of touchedOptionIds) {
      try {
        const transition = await db.runTransaction(async (tx) => {
          const pollSnap = await tx.get(pollRef);
          const poll = pollSnap.data();
          if (!poll) return null;

          const options = (poll.options as PollOptionData[] | undefined) ?? [];
          const option = options.find((o) => o.id === optionId);
          if (!option?.schedulable || !option.minResponses) return null;

          const responsesSnap = await tx.get(
            pollRef.collection("responses").where("optionIds", "array-contains", optionId),
          );
          const count = responsesSnap.size;
          const thresholdMet = (poll.optionThresholdMet as Record<string, boolean> | undefined) ?? {};
          const wasMet = thresholdMet[optionId] === true;
          const isMet = count >= option.minResponses;
          if (isMet === wasMet) return null;

          tx.update(pollRef, {[`optionThresholdMet.${optionId}`]: isMet});
          return {isMet, count, option, question: (poll.question as string | undefined) ?? "the match poll"};
        });

        if (!transition) continue;

        const {isMet, count, option, question} = transition;
        const {day, time} = formatOptionDateTime(option.proposedDate);

        if (isMet) {
          await notifyRegisteredMembers({
            clubId,
            title: `${clubName} — 🏏 Game's on!`,
            body: `Match is happening on ${day} at ${time}. We've got ${count} players! Already in? ` +
              "Don't drop out. Haven't answered yet (or picked something else)? Jump in, there's room",
            data: {type: "match_poll", clubId, pollId},
          });
        } else {
          await notifyRegisteredMembers({
            clubId,
            title: `${clubName} — 😬 Game's off — for now`,
            body: `Match on ${day} at ${time} is no longer on — we've dropped below the minimum ` +
              `(${count} players). Haven't answered yet (or picked something else)? Jump in now to help bring it back!`,
            data: {type: "match_poll", clubId, pollId},
          });
        }
        logger.info(`onPollResponseWritten: ${question} / ${option.label} -> ${isMet ? "on" : "off"} (${count})`);
      } catch (err) {
        logger.error(`onPollResponseWritten: failed evaluating option ${optionId}`, err);
      }
    }
  },
);
