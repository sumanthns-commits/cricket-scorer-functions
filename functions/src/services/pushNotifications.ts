import {Expo} from "expo-server-sdk";
import type {ExpoPushMessage, ExpoPushTicket} from "expo-server-sdk";
import {getFirestore, FieldValue, Timestamp} from "firebase-admin/firestore";
import type {PushNotificationData} from "../types/index.js";

const expo = new Expo();

// Android-only (per Expo's push payload) — the large icon shown in the
// expanded notification. iOS shows the app icon automatically for every
// notification regardless, no server-side control needed there. The small
// Android status-bar icon is separate again — a monochrome silhouette baked
// into the native build via app.json's expo-notifications plugin
// (assets/android-icon-monochrome.png), not something a push payload field
// can change. Hosted on this repo's own Firebase Hosting site, resized to
// 256px (Expo's push relay fetches it per send — no need for the full
// 1024px app-icon source).
const NOTIFICATION_ICON_URL = "https://crease-24487.web.app/assets/notification-icon.png";

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
      icon: NOTIFICATION_ICON_URL,
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
        await Promise.all([
          pruneInvalidTokens(db, tickets, chunkRecipients),
          recordPendingReceipts(db, tickets, chunkRecipients),
        ]);
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

// An 'ok' ticket only means Expo accepted the request — a token that's gone
// stale (reinstall, rebuild, uninstall) still tickets 'ok' and then silently
// fails at actual delivery. That real outcome only shows up in Expo's
// separate receipts endpoint, which needs the send to have actually reached
// Apple/Google first — so this just records the (uid, token) behind each
// receipt id for checkPushReceipts (scheduled function) to resolve later,
// rather than checking receipts inline here.
async function recordPendingReceipts(
  db: FirebaseFirestore.Firestore,
  tickets: ExpoPushTicket[],
  chunkRecipients: Recipient[],
): Promise<void> {
  const createdAt = Timestamp.now();
  await Promise.all(
    tickets.map((ticket, i) => {
      if (ticket.status !== "ok") return undefined;
      const recipient = chunkRecipients[i];
      if (!recipient) return undefined;
      return db.collection("pushReceipts").doc(ticket.id).set({
        uid: recipient.uid,
        token: recipient.token,
        createdAt,
      }).catch(() => undefined);
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
