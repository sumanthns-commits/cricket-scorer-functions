import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {getFirestore} from "firebase-admin/firestore";
import {sendPushToUsers} from "../../services/pushNotifications.js";

const REGION = "australia-southeast1";

/**
 * Notifies every admin of a club when a new join request comes in, so they
 * can review and approve/reject it. Admin-ness is per-club
 * (clubs/{clubId}/players/{uid}.role === 'admin') — there is no global
 * admins list. Always sent (not gated by notificationPrefs.matchNotifications
 * — that opt-out only covers match-live/match-finished sends).
 */
export const onJoinRequestCreated = onDocumentCreated(
  {document: "clubs/{clubId}/joinRequests/{requesterUid}", region: REGION},
  async (event) => {
    const data = event.data?.data();
    if (!data || data.status !== "pending") return;

    const clubId = event.params.clubId as string;
    const requesterUid = event.params.requesterUid as string;
    const requesterName = (data.displayName as string) || "Someone";

    const db = getFirestore();
    const [adminsSnap, clubSnap] = await Promise.all([
      db.collection("clubs").doc(clubId).collection("players")
        .where("role", "==", "admin")
        .get(),
      db.collection("clubs").doc(clubId).get(),
    ]);
    const clubName = (clubSnap.data()?.name as string | undefined) ?? "your club";
    const adminUids = adminsSnap.docs.map((d) => d.id).filter((uid) => uid !== requesterUid);
    if (adminUids.length === 0) return;

    try {
      await sendPushToUsers({
        uids: adminUids,
        title: "New join request",
        body: `${requesterName} wants to join ${clubName}`,
        data: {type: "join_request", clubId},
      });
    } catch (err) {
      console.error("[onJoinRequestCreated] notification failed", err);
    }
  },
);
