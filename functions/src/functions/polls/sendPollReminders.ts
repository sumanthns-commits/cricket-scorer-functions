import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {logger} from "firebase-functions/v2";
import {sendPushToUsers} from "../../services/pushNotifications.js";

const REGION = "australia-southeast1";
const REMINDER_INTERVAL_MS = 4 * 60 * 60 * 1000;

interface PollOptionData {
  id: string;
  schedulable?: boolean;
  proposedDate?: FirebaseFirestore.Timestamp;
}

/**
 * Every 4 hours, nudges club members who haven't responded to a still-open
 * match poll. "Still open" means at least one schedulable option hasn't yet
 * hit its minResponses threshold (optionThresholdMet[id] !== true), hasn't
 * been converted to a match, and its date hasn't passed — once every
 * schedulable option is resolved one way or another, the poll stops getting
 * evaluated (no more pushes, but the doc itself lives until
 * cleanupExpiredPolls removes it after its date).
 *
 * Cadence is tracked via lastReminderCheckAt on the poll doc (defaulting to
 * createdAt) rather than assuming this function's own run times line up
 * with a poll's creation time — keeps the 4h spacing accurate regardless of
 * exactly when this sweep happens to run.
 */
export const sendPollReminders = onSchedule(
  {schedule: "every 4 hours", region: REGION, timeZone: "Australia/Sydney"},
  async () => {
    const db = getFirestore();
    const now = Timestamp.now();

    const clubsSnap = await db.collection("clubs").get();
    for (const clubDoc of clubsSnap.docs) {
      const clubId = clubDoc.id;
      const pollsSnap = await clubDoc.ref.collection("matchPolls").get();

      for (const pollDoc of pollsSnap.docs) {
        const poll = pollDoc.data();

        const expiresAt = poll.expiresAt as FirebaseFirestore.Timestamp | undefined;
        if (expiresAt && expiresAt.toMillis() <= now.toMillis()) continue;

        const lastCheck = (poll.lastReminderCheckAt as FirebaseFirestore.Timestamp | undefined) ??
          (poll.createdAt as FirebaseFirestore.Timestamp | undefined);
        if (lastCheck && now.toMillis() - lastCheck.toMillis() < REMINDER_INTERVAL_MS) continue;

        const options = (poll.options as PollOptionData[] | undefined) ?? [];
        const convertedOptionIds = new Set(
          ((poll.convertedMatches as {optionId: string}[] | undefined) ?? []).map((c) => c.optionId),
        );
        const thresholdMet = (poll.optionThresholdMet as Record<string, boolean> | undefined) ?? {};

        const stillOpen = options.some((o) => {
          if (!o.schedulable) return false;
          if (convertedOptionIds.has(o.id)) return false;
          if (o.proposedDate && o.proposedDate.toMillis() <= now.toMillis()) return false;
          if (thresholdMet[o.id] === true) return false;
          return true;
        });

        if (!stillOpen) {
          await pollDoc.ref.update({lastReminderCheckAt: now});
          continue;
        }

        try {
          const [playersSnap, responsesSnap] = await Promise.all([
            clubDoc.ref.collection("players").where("type", "==", "registered").get(),
            pollDoc.ref.collection("responses").get(),
          ]);
          const respondedUids = new Set(responsesSnap.docs.map((d) => d.id));
          const nonResponderUids = playersSnap.docs.map((d) => d.id).filter((uid) => !respondedUids.has(uid));

          if (nonResponderUids.length > 0) {
            await sendPushToUsers({
              uids: nonResponderUids,
              title: "Still waiting on you 🏏",
              body: (poll.question as string | undefined) ?? "New match poll",
              data: {type: "match_poll", clubId, pollId: pollDoc.id},
              requireMatchPref: true,
            });
          }
        } catch (err) {
          logger.error(`sendPollReminders: failed for poll ${pollDoc.id}`, err);
        }

        await pollDoc.ref.update({lastReminderCheckAt: now});
      }
    }
  },
);
