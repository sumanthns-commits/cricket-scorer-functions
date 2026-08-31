import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {getFirestore} from "firebase-admin/firestore";
import {notifyRegisteredMembers} from "../../services/pushNotifications.js";

const REGION = "australia-southeast1";

/**
 * Notifies every registered member of a club (minus whoever created it) when
 * an admin starts a new match interest poll — the in-app counterpart to the
 * poll link being shared into the club's WhatsApp group.
 */
export const onPollCreated = onDocumentCreated(
  {document: "clubs/{clubId}/matchPolls/{pollId}", region: REGION},
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const clubId = event.params.clubId as string;
    const pollId = event.params.pollId as string;
    const question = (data.question as string | undefined) ?? "New match poll";
    const createdBy = data.createdBy as string | undefined;

    try {
      // Club name in the title — a member can belong to more than one club,
      // so "New match poll" alone doesn't say which one this is about.
      const clubSnap = await getFirestore().collection("clubs").doc(clubId).get();
      const clubName = (clubSnap.data()?.name as string | undefined) ?? "Your club";

      await notifyRegisteredMembers({
        clubId,
        excludeUid: createdBy,
        title: `${clubName} — New match poll`,
        body: question,
        data: {type: "match_poll", clubId, pollId},
      });
    } catch (err) {
      console.error("[onPollCreated] notification failed", err);
    }
  },
);
