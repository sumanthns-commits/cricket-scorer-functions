import {getAuth} from "firebase-admin/auth";
import {getFirestore} from "firebase-admin/firestore";
import {HttpsError} from "firebase-functions/v2/https";

export async function verifyIdToken(idToken: string): Promise<string> {
  const decoded = await getAuth().verifyIdToken(idToken);
  return decoded.uid;
}

export async function getClubIds(uid: string): Promise<string[]> {
  const db = getFirestore();
  const snap = await db.collection("userMemberships").doc(uid).get();
  if (!snap.exists) return [];
  const data = snap.data();
  return data?.clubIds ?? [];
}

export async function assertClubMember(uid: string, clubId: string): Promise<void> {
  const clubIds = await getClubIds(uid);
  if (!clubIds.includes(clubId)) {
    throw new HttpsError("permission-denied", "Not a member of this club");
  }
}

export async function assertAdmin(uid: string): Promise<void> {
  const decoded = await getAuth().getUser(uid);
  if (!decoded.customClaims?.admin) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
}

export async function assertSuperAdmin(uid: string): Promise<void> {
  const decoded = await getAuth().getUser(uid);
  if (!decoded.customClaims?.superAdmin) {
    throw new HttpsError("permission-denied", "Super-admin access required");
  }
}
