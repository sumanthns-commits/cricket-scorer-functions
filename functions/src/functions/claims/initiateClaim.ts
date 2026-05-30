import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { CloudTasksClient } from "@google-cloud/tasks";
import { assertClubMember } from "../../services/firebaseAuth.js";
import { mergeStatsFromTotals } from "../../utils/statsCalculator.js";
import type { CareerStats, ClaimSnapshot } from "../../types/index.js";

const REGION = "australia-southeast1";
const COOLDOWN_SECONDS = 48 * 60 * 60; // 48 hours

async function scheduleAutoMergeTask(claimId: string): Promise<string> {
  const client = new CloudTasksClient();
  const project = process.env.GCLOUD_PROJECT ?? "";
  const queue = "auto-merge-claims";
  const parent = client.queuePath(project, REGION, queue);

  const url = `https://${REGION}-${project}.cloudfunctions.net/mergeClaimTask`;
  const body = JSON.stringify({ claimId });

  const [task] = await client.createTask({
    parent,
    task: {
      httpRequest: {
        httpMethod: "POST",
        url,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(body).toString("base64"),
      },
      scheduleTime: {
        seconds: Math.floor(Date.now() / 1000) + COOLDOWN_SECONDS,
      },
    },
  });

  return task.name ?? "";
}

async function cancelTask(taskName: string): Promise<void> {
  if (!taskName) return;
  const client = new CloudTasksClient();
  await client.deleteTask({ name: taskName }).catch(() => undefined);
}

export const initiateClaim = onCall(
  { region: REGION },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Must be signed in");

    const { clubId, ghostPlayerId, registeredPlayerId } = request.data as {
      clubId: string;
      ghostPlayerId: string;
      registeredPlayerId: string;
    };

    if (!clubId || !ghostPlayerId || !registeredPlayerId) {
      throw new HttpsError("invalid-argument", "Missing required fields");
    }

    await assertClubMember(uid, clubId);

    const db = getFirestore();
    const ghostRef = db.collection("players").doc(ghostPlayerId);
    const registeredRef = db.collection("players").doc(registeredPlayerId);
    const claimsRef = db.collection("claims");

    return db.runTransaction(async (tx) => {
      // Guard 1: claimant already has activeClaim
      const existingClaimSnap = await tx.get(
        claimsRef
          .where("claimantUid", "==", uid)
          .where("clubId", "==", clubId)
          .where("status", "in", ["open", "cooldown", "contested"])
          .limit(1)
      );
      if (!existingClaimSnap.empty) {
        throw new HttpsError("already-exists", "You already have an active claim");
      }

      const [ghostSnap, registeredSnap] = await Promise.all([
        tx.get(ghostRef),
        tx.get(registeredRef),
      ]);

      if (!ghostSnap.exists) throw new HttpsError("not-found", "Ghost player not found");
      if (!registeredSnap.exists) throw new HttpsError("not-found", "Registered player not found");

      const ghost = ghostSnap.data()!;
      const registered = registeredSnap.data()!;

      // Guard 2: ghost already linked
      if (ghost.playerType === "linked") {
        throw new HttpsError("failed-precondition", "Ghost player is already linked");
      }

      const ghostStats = ghost.careerStats as CareerStats;
      const registeredStats = registered.careerStats as CareerStats;
      const mergedStats = mergeStatsFromTotals(ghostStats, registeredStats);

      const snapshot: ClaimSnapshot = { ghostStats, registeredStats, mergedStats };
      const now = Timestamp.now();

      const claimStatus: string = ghost.claimStatus ?? "open";

      // Guard 5: contested
      if (claimStatus === "contested") {
        throw new HttpsError("failed-precondition", "Ghost is already contested — wait for resolution");
      }

      // Guard 3: open → start cooldown
      if (claimStatus === "open") {
        const newClaimRef = claimsRef.doc();
        tx.set(newClaimRef, {
          clubId,
          ghostPlayerId,
          claimantUid: uid,
          registeredPlayerId,
          status: "cooldown",
          snapshot,
          cooldownEndsAt: Timestamp.fromMillis(Date.now() + COOLDOWN_SECONDS * 1000),
          createdAt: now,
          updatedAt: now,
        });
        tx.update(ghostRef, {
          claimStatus: "cooldown",
          activeClaim: newClaimRef.id,
        });

        // Schedule after transaction — cannot await inside tx body cleanly
        // We'll update cloudTaskName in a follow-up write outside transaction
        return { claimId: newClaimRef.id, status: "cooldown" };
      }

      // Guard 4: cooldown → contest
      if (claimStatus === "cooldown") {
        const existingClaimId: string = ghost.activeClaim;
        const existingClaimRef = claimsRef.doc(existingClaimId);
        const existingClaimSnap2 = await tx.get(existingClaimRef);
        if (!existingClaimSnap2.exists) {
          throw new HttpsError("internal", "Existing claim not found");
        }
        const existingClaim = existingClaimSnap2.data()!;

        const newClaimRef = claimsRef.doc();
        tx.set(newClaimRef, {
          clubId,
          ghostPlayerId,
          claimantUid: uid,
          registeredPlayerId,
          status: "contested",
          snapshot,
          contestedByClaimId: existingClaimId,
          createdAt: now,
          updatedAt: now,
        });
        tx.update(existingClaimRef, {
          status: "contested",
          contestedByClaimId: newClaimRef.id,
          updatedAt: now,
        });
        tx.update(ghostRef, {
          claimStatus: "contested",
          waitingClaimId: newClaimRef.id,
        });

        // Notify admin via a dedicated doc
        tx.set(db.collection("adminNotifications").doc(), {
          type: "claim_contested",
          clubId,
          ghostPlayerId,
          claim1Id: existingClaimId,
          claim2Id: newClaimRef.id,
          createdAt: now,
        });

        const cloudTaskName: string = existingClaim.cloudTaskName ?? "";
        return { claimId: newClaimRef.id, status: "contested", cancelTask: cloudTaskName };
      }

      throw new HttpsError("internal", "Unexpected ghost claim status");
    }).then(async (result) => {
      // Post-transaction: schedule or cancel tasks
      if (result.status === "cooldown") {
        const taskName = await scheduleAutoMergeTask(result.claimId);
        await db.collection("claims").doc(result.claimId).update({ cloudTaskName: taskName });
      } else if (result.status === "contested" && result.cancelTask) {
        await cancelTask(result.cancelTask);
      }
      return { claimId: result.claimId, status: result.status };
    });
  }
);
