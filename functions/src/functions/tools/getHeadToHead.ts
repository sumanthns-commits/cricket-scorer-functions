import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {assertClubMember} from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getHeadToHead = onCall(
  {region: REGION},
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const {clubId, batsmanId, bowlerId} = request.data as {
      clubId: string;
      batsmanId: string;
      bowlerId: string;
    };
    if (!clubId || !batsmanId || !bowlerId) {
      throw new HttpsError("invalid-argument", "Missing required fields");
    }

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const snap = await db
      .collection("headToHead")
      .where("clubId", "==", clubId)
      .where("batsmanId", "==", batsmanId)
      .where("bowlerId", "==", bowlerId)
      .limit(1)
      .get();

    if (snap.empty) return null;
    return {id: snap.docs[0].id, ...snap.docs[0].data()};
  }
);
