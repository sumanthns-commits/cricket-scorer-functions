import {onDocumentCreated} from "firebase-functions/v2/firestore";
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
      await notifyRegisteredMembers({
        clubId,
        excludeUid: createdBy,
        title: "New match poll",
        body: question,
        data: {type: "match_poll", clubId, pollId},
      });
    } catch (err) {
      console.error("[onPollCreated] notification failed", err);
    }
  },
);
