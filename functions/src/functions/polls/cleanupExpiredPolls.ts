import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore, Timestamp} from "firebase-admin/firestore";
import {logger} from "firebase-functions/v2";

const REGION = "australia-southeast1";

/**
 * Permanently deletes match polls a day after every candidate date they
 * reference has passed (`expiresAt`, computed client-side at poll creation
 * as one day after the max proposedDate across a poll's options — see
 * matchPollService.createMatchPoll in the app repo). Runs daily, once per
 * club — matchPolls is only ever queried as a subcollection here (not
 * collection-group), so this needs no extra Firestore index beyond the
 * automatic single-field one.
 */
export const cleanupExpiredPolls = onSchedule(
  {schedule: "every 24 hours", region: REGION, timeZone: "Australia/Sydney"},
  async () => {
    const db = getFirestore();
    const now = Timestamp.now();

    const clubsSnap = await db.collection("clubs").get();
    for (const clubDoc of clubsSnap.docs) {
      const pollsSnap = await clubDoc.ref
        .collection("matchPolls")
        .where("expiresAt", "<=", now)
        .get();

      for (const pollDoc of pollsSnap.docs) {
        try {
          // recursiveDelete removes the poll doc and its responses subcollection.
          await db.recursiveDelete(pollDoc.ref);
          logger.info(`cleanupExpiredPolls: deleted poll ${pollDoc.id} (club ${clubDoc.id})`);
        } catch (err) {
          // Don't let one failure abort the rest of the sweep; retry next run.
          logger.error(`cleanupExpiredPolls: failed to delete poll ${pollDoc.id}`, err);
        }
      }
    }
  },
);
