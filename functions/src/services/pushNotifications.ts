import {Expo} from "expo-server-sdk";
import type {ExpoPushMessage, ExpoPushTicket} from "expo-server-sdk";
import {getFirestore, FieldValue} from "firebase-admin/firestore";
import type {PushNotificationData} from "../types/index.js";

const expo = new Expo();

interface Recipient {
  uid: string;
  token: string;
}

interface SendPushParams {
  uids: string[];
  excludeUid?: string;
  title: string;
  body: string;
  data: PushNotificationData;
  // Only match-live/match-finished sends respect the opt-out — join-request
  // and approval notifications are always sent regardless of this pref.
  requireMatchPref?: boolean;
}

/**
 * Sends a push notification to every device registered against the given
 * uids (minus excludeUid), via Expo's push service. Never throws — a bad
 * chunk is logged and skipped so one recipient's failure can't cost the
 * others their notification. Invalid/uninstalled tokens are pruned from
 * the owning user doc as they're discovered.
 */
export async function sendPushToUsers(params: SendPushParams): Promise<void> {
  const {uids, excludeUid, title, body, data, requireMatchPref} = params;
  const targetUids = Array.from(new Set(uids)).filter((uid) => uid !== excludeUid);
  if (targetUids.length === 0) return;

  const db = getFirestore();

  try {
    const userSnaps = await db.getAll(
      ...targetUids.map((uid) => db.collection("users").doc(uid)),
    );

    const recipients: Recipient[] = [];
    for (const snap of userSnaps) {
      const user = snap.data();
      if (!user) continue;
      if (requireMatchPref && user.notificationPrefs?.matchNotifications === false) continue;
      const tokens = (user.expoPushTokens as string[] | undefined) ?? [];
      for (const token of tokens) {
        if (Expo.isExpoPushToken(token)) recipients.push({uid: snap.id, token});
      }
    }
    if (recipients.length === 0) return;

    const messages: ExpoPushMessage[] = recipients.map(({token}) => ({
      to: token,
      sound: "default",
      title,
      body,
      data,
    }));

    // chunkPushNotifications only groups by size limit — it never reorders,
    // so slicing `recipients` by the same running offset keeps each chunk's
    // tickets zipped against the right uid/token for pruning below.
    const messageChunks = expo.chunkPushNotifications(messages);
    let offset = 0;
    for (const chunk of messageChunks) {
      const chunkRecipients = recipients.slice(offset, offset + chunk.length);
      offset += chunk.length;
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        await pruneInvalidTokens(db, tickets, chunkRecipients);
      } catch (err) {
        console.error("[pushNotifications] chunk send failed", err);
      }
    }
  } catch (err) {
    console.error("[pushNotifications] sendPushToUsers failed", err);
  }
}

async function pruneInvalidTokens(
  db: FirebaseFirestore.Firestore,
  tickets: ExpoPushTicket[],
  chunkRecipients: Recipient[],
): Promise<void> {
  await Promise.all(
    tickets.map(async (ticket, i) => {
      if (ticket.status !== "error") return;
      const recipient = chunkRecipients[i];
      if (ticket.details?.error !== "DeviceNotRegistered") {
        // Every other error (InvalidCredentials — missing/misconfigured
        // APNs or FCM push credentials on Expo's side, MessageRateExceeded,
        // MessageTooBig, ProviderError, DeveloperError, ExpoError) was
        // previously swallowed here with zero trace. Log it so a delivery
        // failure shows up in Cloud Functions logs instead of just
        // silently not arriving on-device.
        console.error(
          "[pushNotifications] delivery error",
          {uid: recipient?.uid, error: ticket.details?.error, message: ticket.message},
        );
        return;
      }
      const token = ticket.details?.expoPushToken ?? recipient?.token;
      if (!recipient || !token) return;
      await db
        .collection("users")
        .doc(recipient.uid)
        .update({expoPushTokens: FieldValue.arrayRemove(token)})
        .catch(() => undefined);
    }),
  );
}

interface NotifyRegisteredMembersParams {
  clubId: string;
  excludeUid?: string;
  title: string;
  body: string;
  data: PushNotificationData;
}

/**
 * Notifies every registered (non-ghost) member of a club — used by the
 * match-live and match-finished triggers. Always respects the per-user
 * matchNotifications opt-out (default on).
 */
export async function notifyRegisteredMembers(params: NotifyRegisteredMembersParams): Promise<void> {
  const {clubId, excludeUid, title, body, data} = params;
  const db = getFirestore();
  const playersSnap = await db
    .collection("clubs").doc(clubId).collection("players")
    .where("type", "==", "registered")
    .get();
  const uids = playersSnap.docs.map((d) => d.id);
  await sendPushToUsers({uids, excludeUid, title, body, data, requireMatchPref: true});
}
