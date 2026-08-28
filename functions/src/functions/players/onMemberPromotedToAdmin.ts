import {onDocumentWritten} from "firebase-functions/v2/firestore";
import {getFirestore} from "firebase-admin/firestore";
import {sendPushToUsers} from "../../services/pushNotifications.js";

const REGION = "australia-southeast1";

/**
 * Notifies a player when they're promoted to admin (member -> admin only —
 * `before` must exist, so the club creator's initial admin role set at
 * club-creation time never fires this; that's not a "promotion"). Always
 * sent, not gated by notificationPrefs.matchNotifications — that opt-out
 * only covers match-live/match-finished sends, same as join-request/approval.
 */
export const onMemberPromotedToAdmin = onDocumentWritten(
  {document: "clubs/{clubId}/players/{playerId}", region: REGION},
  async (event) => {
    const before = event.data?.before.data();
    const after = event.data?.after.data();
    if (!before || !after) return;
    if (after.role !== "admin" || before.role === "admin") return;

    const clubId = event.params.clubId as string;
    const playerId = event.params.playerId as string;

    const clubSnap = await getFirestore().collection("clubs").doc(clubId).get();
    const clubName = (clubSnap.data()?.name as string | undefined) ?? "your club";

    try {
      await sendPushToUsers({
        uids: [playerId],
        title: "👑 You're an admin now!",
        body: `You now run ${clubName} — schedule matches, manage the squad, and boss people around (nicely).`,
        data: {type: "made_admin", clubId},
      });
    } catch (err) {
      console.error("[onMemberPromotedToAdmin] notification failed", err);
    }
  },
);
