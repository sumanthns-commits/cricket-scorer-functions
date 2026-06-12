import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { getFirestore } from "firebase-admin/firestore";

const REGION = "australia-southeast1";

/**
 * Keeps each `clubNames` registry entry's `archived` flag in sync with its
 * club's `archivedAt`. The registry is the only signed-in-readable view of
 * clubs (the club docs are member-private), so club search reads it directly —
 * and must be able to hide archived clubs. Archiving deliberately does NOT
 * release the name reservation (that happens at permanent deletion, 30 days
 * later, in cleanupArchivedClubs), so without this flag an archived club would
 * still surface in search and accept join requests.
 *
 * Keyed by `clubId` (like cleanupArchivedClubs) rather than the normalised name,
 * so a club renamed after creation is still matched and duplicate same-named
 * clubs never clobber each other's reservation.
 */
export const syncClubNameArchived = onDocumentWritten(
  { document: "clubs/{clubId}", region: REGION },
  async (event) => {
    const after = event.data?.after.data();
    if (!after) return; // deletion → cleanupArchivedClubs removes the registry entry

    const clubId = event.params.clubId as string;
    const archived = !!after.archivedAt;

    const db = getFirestore();
    const names = await db.collection("clubNames").where("clubId", "==", clubId).get();

    await Promise.all(
      names.docs
        .filter((n) => n.data().archived !== archived)
        .map((n) => n.ref.update({ archived })),
    );
  },
);
