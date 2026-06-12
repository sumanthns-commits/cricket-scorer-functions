import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

const REGION = "australia-southeast1";
const RETENTION_DAYS = 30;

/**
 * Permanently deletes clubs that have been archived for more than RETENTION_DAYS,
 * along with every subcollection (players, matches, matches/*\/overs, claims) via
 * recursiveDelete, and releases their reserved name in `clubNames`.
 *
 * Runs daily. Clubs are archived from the app by stamping `archivedAt`; restoring
 * clears it back to null, so only genuinely-archived clubs match the query.
 */
export const cleanupArchivedClubs = onSchedule(
  { schedule: "every 24 hours", region: REGION, timeZone: "Australia/Sydney" },
  async () => {
    const db = getFirestore();
    const cutoff = Timestamp.fromMillis(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);

    // Inequality matches only docs where archivedAt is an actual Timestamp, so
    // active clubs (archivedAt null/absent) are never selected.
    const snap = await db.collection("clubs").where("archivedAt", "<=", cutoff).get();
    if (snap.empty) {
      logger.info("cleanupArchivedClubs: no clubs past retention");
      return;
    }

    for (const clubDoc of snap.docs) {
      const clubId = clubDoc.id;
      try {
        // recursiveDelete removes the club doc and ALL nested subcollections.
        await db.recursiveDelete(clubDoc.ref);

        // Free the reserved name(s). Keyed by clubId so a club renamed after
        // creation still has its (stale-keyed) reservation cleaned up.
        const names = await db.collection("clubNames").where("clubId", "==", clubId).get();
        await Promise.all(names.docs.map((n) => n.ref.delete()));

        logger.info(`cleanupArchivedClubs: deleted club ${clubId}`);
      } catch (err) {
        // Don't let one failure abort the rest of the batch; retry next run.
        logger.error(`cleanupArchivedClubs: failed to delete club ${clubId}`, err);
      }
    }
  },
);
