import {onSchedule} from "firebase-functions/v2/scheduler";
import {getFirestore, FieldValue, Timestamp} from "firebase-admin/firestore";
import {logger} from "firebase-functions/v2";
import {Expo} from "expo-server-sdk";
import type {ExpoPushReceiptId} from "expo-server-sdk";

const REGION = "australia-southeast1";
// Expo needs time to actually attempt delivery before a receipt reflects the
// real outcome — checking immediately after send would mostly find nothing
// resolved yet.
const MIN_AGE_MINUTES = 15;
// Expo only retains receipts for about a day — a pending record that's still
// unresolved past that point never will be, so it's swept away rather than
// checked forever.
const MAX_AGE_HOURS = 48;

const expo = new Expo();

/**
 * Sweeps pushReceipts/{receiptId} (written by sendPushToUsers's
 * recordPendingReceipts for every ticket Expo accepted) against Expo's
 * actual delivery outcome. An accepted ticket only means Expo queued the
 * request — a stale token (reinstall, rebuild, uninstall) still tickets 'ok'
 * and then fails silently at real delivery, which only shows up here. A
 * DeviceNotRegistered receipt prunes that token from its owning user doc,
 * mirroring the immediate ticket-time pruning in pushNotifications.ts;
 * every other error is logged instead of being pruned. Without this sweep,
 * dead tokens accumulate forever and every future push to them is a no-op
 * that nothing ever reports.
 */
export const checkPushReceipts = onSchedule(
  {schedule: "every 30 minutes", region: REGION, timeZone: "Australia/Sydney"},
  async () => {
    const db = getFirestore();
    const cutoff = Timestamp.fromMillis(Date.now() - MIN_AGE_MINUTES * 60 * 1000);
    const maxAgeCutoff = Timestamp.fromMillis(Date.now() - MAX_AGE_HOURS * 60 * 60 * 1000);

    const snap = await db.collection("pushReceipts").where("createdAt", "<=", cutoff).get();
    if (snap.empty) return;

    const idToDoc = new Map(snap.docs.map((d) => [d.id, d]));
    const receiptIds = Array.from(idToDoc.keys()) as ExpoPushReceiptId[];
    const chunks = expo.chunkPushNotificationReceiptIds(receiptIds);

    for (const chunk of chunks) {
      try {
        const receipts = await expo.getPushNotificationReceiptsAsync(chunk);
        await Promise.all(
          chunk.map(async (id) => {
            const doc = idToDoc.get(id);
            if (!doc) return;
            const data = doc.data() as {uid: string; token: string; createdAt: Timestamp};
            const receipt = receipts[id];

            // Expo hasn't resolved this id yet — leave it for a later sweep,
            // unless it's aged past Expo's own retention window.
            if (!receipt) {
              if (data.createdAt.toMillis() <= maxAgeCutoff.toMillis()) await doc.ref.delete();
              return;
            }

            if (receipt.status === "error") {
              if (receipt.details?.error === "DeviceNotRegistered") {
                await db.collection("users").doc(data.uid).update({
                  expoPushTokens: FieldValue.arrayRemove(data.token),
                }).catch(() => undefined);
              } else {
                logger.error("[checkPushReceipts] delivery error", {
                  uid: data.uid, error: receipt.details?.error, message: receipt.message,
                });
              }
            }

            await doc.ref.delete();
          }),
        );
      } catch (err) {
        logger.error("[checkPushReceipts] receipt fetch failed", err);
      }
    }
  },
);
