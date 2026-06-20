import {onCall, HttpsError} from "firebase-functions/v2/https";
import {getFirestore} from "firebase-admin/firestore";
import {assertClubMember} from "../../services/firebaseAuth.js";

const REGION = "australia-southeast1";

export const getBattingInsights = onCall(
  {region: REGION, invoker: "public"},
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const {clubId, playerId} = request.data as { clubId: string; playerId: string };
    if (!clubId || !playerId) throw new HttpsError("invalid-argument", "Missing required fields");

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const snap = await db
      .collection("clubs")
      .doc(clubId)
      .collection("players")
      .doc(playerId)
      .get();

    if (!snap.exists) return {};

    const data = snap.data() ?? {};

    // wagonWheel is accumulated by onMatchCompleted as a map { sector → runs }.
    // Normalise to a dense 12-length array (also tolerates a stored array).
    const SECTORS = 12;
    const stored = data.careerStats?.wagonWheel;
    const wagonWheel = new Array<number>(SECTORS).fill(0);
    if (Array.isArray(stored)) {
      for (let i = 0; i < Math.min(stored.length, SECTORS); i++) {
        wagonWheel[i] = typeof stored[i] === "number" ? stored[i] : 0;
      }
    } else if (stored && typeof stored === "object") {
      for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
        const sector = Number(k);
        if (Number.isInteger(sector) && sector >= 0 && sector < SECTORS) {
          wagonWheel[sector] = typeof v === "number" ? v : 0;
        }
      }
    }

    return {
      id: snap.id,
      ...data,
      wagonWheel,
      batsmanHand: data.battingHand === "LHB" ? "LHB" : "RHB",
    };
  }
);
