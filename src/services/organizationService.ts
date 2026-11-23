import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collection,
  collectionGroup,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  onSnapshot,
  limit,
} from 'firebase/firestore';
import { db, storage } from '../config/firebase';
import { ref as storageRef, uploadString, getDownloadURL } from 'firebase/storage';
import type { Organization, CachedAnchors, ChurchMember, AttendanceRecordInput } from '../types';

const STORAGE_KEY_ANCHORS = '@sanctuary_cached_anchors';
const STORAGE_KEY_ORG = '@sanctuary_active_org';
const STORAGE_KEY_MEMBER = '@sanctuary_member_profile';
const STORAGE_KEY_FACE_VAULT_DEVICE = '@presenti_face_vault_device';
const STORAGE_KEY_DEVICE_WORKER_LOCK = '@presenti_device_worker_lock';

export interface LocalFaceVaultEntry {
  facePhotoURL: string;
  faceEmbedding: number[];
  faceEnrolledAt: string;
  memberId?: string;
  email?: string;
  orgId?: string;
}

export interface DeviceWorkerLock {
  deviceId: string;
  memberId: string;
  email: string;
  fullName: string;
  orgId: string;
  orgName: string;
  boundAt: string;
}

function getFaceVaultEmailKey(email: string): string {
  return `@presenti_face_vault_email_${email.trim().toLowerCase()}`;
}

function getFaceVaultMemberKey(memberId: string): string {
  return `@presenti_face_vault_member_${memberId.trim()}`;
}

/**
 * Permanently stores the worker's enrolled face on the device (survives sign-out
 * and Admin <-> Worker account switches) so AI verification reads locally in 0ms.
 */
export async function saveFaceToLocalVault(params: {
  facePhotoURL: string;
  faceEmbedding?: number[];
  faceEnrolledAt?: string;
  email?: string;
  memberId?: string;
  orgId?: string;
}): Promise<void> {
  if (!params.facePhotoURL || !params.facePhotoURL.trim()) return;
  const entry: LocalFaceVaultEntry = {
    facePhotoURL: params.facePhotoURL.trim(),
    faceEmbedding:
      params.faceEmbedding && params.faceEmbedding.length > 0
        ? params.faceEmbedding
        : [1],
    faceEnrolledAt: params.faceEnrolledAt || new Date().toISOString(),
    email: params.email?.trim().toLowerCase(),
    memberId: params.memberId?.trim(),
    orgId: params.orgId?.trim(),
  };

  const payload = JSON.stringify(entry);
  const writes: Array<Promise<void>> = [
    AsyncStorage.setItem(STORAGE_KEY_FACE_VAULT_DEVICE, payload),
  ];
  if (entry.email) {
    writes.push(AsyncStorage.setItem(getFaceVaultEmailKey(entry.email), payload));
  }
  if (entry.memberId) {
    writes.push(AsyncStorage.setItem(getFaceVaultMemberKey(entry.memberId), payload));
  }
  await Promise.all(writes).catch(() => {});
}

/**
 * Reads the enrolled face directly from the local device storage (0ms offline read).
 */
export async function loadFaceFromLocalVault(
  email?: string,
  memberId?: string
): Promise<LocalFaceVaultEntry | null> {
  const cleanEmail = (email || '').trim().toLowerCase();
  const cleanMemberId = (memberId || '').trim();

  try {
    if (cleanEmail) {
      const rawByEmail = await AsyncStorage.getItem(getFaceVaultEmailKey(cleanEmail));
      if (rawByEmail) {
        const parsed = JSON.parse(rawByEmail) as LocalFaceVaultEntry;
        if (parsed?.facePhotoURL) return parsed;
      }
    }

    if (cleanMemberId) {
      const rawByMember = await AsyncStorage.getItem(getFaceVaultMemberKey(cleanMemberId));
      if (rawByMember) {
        const parsed = JSON.parse(rawByMember) as LocalFaceVaultEntry;
        if (parsed?.facePhotoURL) return parsed;
      }
    }

    const rawDevice = await AsyncStorage.getItem(STORAGE_KEY_FACE_VAULT_DEVICE);
    if (rawDevice) {
      const parsed = JSON.parse(rawDevice) as LocalFaceVaultEntry;
      if (
        parsed?.facePhotoURL &&
        (!cleanEmail || !parsed.email || parsed.email.toLowerCase() === cleanEmail)
      ) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

export async function clearLocalFaceVault(
  email?: string,
  memberId?: string
): Promise<void> {
  const keys: string[] = [STORAGE_KEY_FACE_VAULT_DEVICE];
  if (email && email.trim()) {
    keys.push(getFaceVaultEmailKey(email));
  }
  if (memberId && memberId.trim()) {
    keys.push(getFaceVaultMemberKey(memberId));
  }
  await AsyncStorage.multiRemove(keys).catch(() => {});
}

/**
 * Hydrates a member profile with their on-device enrolled face photo so switching
 * from Admin back to Worker (or signing back in) immediately restores the face.
 */
export async function hydrateMemberWithLocalFaceVault(
  member: ChurchMember,
  orgId?: string
): Promise<ChurchMember> {
  const adminResetAt = (member as any).faceResetByAdminAt as string | undefined;
  const localVault = await loadFaceFromLocalVault(member.email, member.id);

  // If an admin explicitly reset this worker's Face ID after the local vault was saved,
  // respect the admin reset and clear the local vault so the worker re-enrolls once.
  if (adminResetAt && !member.isFaceEnrolled) {
    if (!localVault?.faceEnrolledAt || localVault.faceEnrolledAt <= adminResetAt) {
      await clearLocalFaceVault(member.email, member.id);
      return member;
    }
  }

  if (localVault?.facePhotoURL) {
    const needsCloudSync = !member.facePhotoURL || !member.isFaceEnrolled;
    member.facePhotoURL = localVault.facePhotoURL;
    member.isFaceEnrolled = true;
    member.faceEmbedding =
      member.faceEmbedding && member.faceEmbedding.length > 0
        ? member.faceEmbedding
        : localVault.faceEmbedding || [1];
    member.faceEnrolledAt = member.faceEnrolledAt || localVault.faceEnrolledAt;

    if (needsCloudSync && orgId && member.id) {
      updateDoc(
        doc(db, 'churches', orgId, 'members', member.id),
        cleanFirestorePayload({
          isFaceEnrolled: true,
          faceEmbedding: member.faceEmbedding,
          faceEnrolledAt: member.faceEnrolledAt,
          facePhotoURL: localVault.facePhotoURL,
        })
      ).catch(() => {});
    }
    return member;
  }

  // If local vault was empty but Firestore has the enrolled face, cache it to local vault now
  if (member.facePhotoURL) {
    await saveFaceToLocalVault({
      facePhotoURL: member.facePhotoURL,
      faceEmbedding: member.faceEmbedding,
      faceEnrolledAt: member.faceEnrolledAt,
      email: member.email,
      memberId: member.id,
      orgId,
    });
  }

  return member;
}

/**
 * Saves the 1-Worker-1-Phone binding both locally on the device and in Firestore.
 */
export async function saveDeviceWorkerLock(lock: DeviceWorkerLock): Promise<void> {
  if (!lock.deviceId) return;
  const cleanLock: DeviceWorkerLock = {
    ...lock,
    email: (lock.email || '').trim().toLowerCase(),
  };
  await AsyncStorage.setItem(
    STORAGE_KEY_DEVICE_WORKER_LOCK,
    JSON.stringify(cleanLock)
  ).catch(() => {});

  try {
    await setDoc(
      doc(db, 'device_bindings', cleanLock.deviceId),
      cleanFirestorePayload(cleanLock),
      { merge: true }
    );
  } catch {
    // Non-fatal if offline
  }
}

export async function clearDeviceWorkerLock(deviceId?: string): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY_DEVICE_WORKER_LOCK).catch(() => {});
  if (deviceId) {
    await deleteDoc(doc(db, 'device_bindings', deviceId)).catch(() => {});
  }
}

/**
 * Enforces strict 1-Worker-1-Phone and 1-Organization-Until-Admin-Releases security:
 * - Once a phone has created or signed into a worker account, NO other worker account
 *   can sign in or be created on that phone unless the Admin deletes that worker or unbinds the phone.
 * - A registered worker cannot join another organization until their previous organization's
 *   Admin deletes their worker profile from the organization.
 */
export async function enforceDeviceWorkerLock(params: {
  deviceId?: string;
  candidateEmail?: string;
  targetOrgId?: string;
}): Promise<void> {
  const cleanDeviceId = (params.deviceId || '').trim();
  const cleanEmail = (params.candidateEmail || '').trim().toLowerCase();
  const targetOrgId = (params.targetOrgId || '').trim();

  // 1. Check active device lock (local + cloud device_bindings)
  if (cleanDeviceId) {
    let lock: DeviceWorkerLock | null = null;
    try {
      const localRaw = await AsyncStorage.getItem(STORAGE_KEY_DEVICE_WORKER_LOCK);
      if (localRaw) {
        lock = JSON.parse(localRaw) as DeviceWorkerLock;
      }
    } catch {}

    try {
      const cloudSnap = await getDoc(doc(db, 'device_bindings', cleanDeviceId));
      if (cloudSnap.exists()) {
        lock = cloudSnap.data() as DeviceWorkerLock;
      } else {
        // Fallback: query all organization members in Firestore for this boundDeviceId
        // (protects against cleared App Data even if device_bindings doc wasn't written yet)
        const cgSnap = await getDocs(
          query(collectionGroup(db, 'members'), where('boundDeviceId', '==', cleanDeviceId), limit(1))
        );
        if (!cgSnap.empty) {
          const memDoc = cgSnap.docs[0];
          const memData = memDoc.data();
          const orgRef = memDoc.ref.parent.parent;
          const orgId = orgRef?.id || '';
          const orgSnap = orgId ? await getDoc(doc(db, 'churches', orgId)).catch(() => null) : null;
          if (orgId && (!orgSnap || orgSnap.exists())) {
            lock = {
              deviceId: cleanDeviceId,
              memberId: memDoc.id,
              email: (memData.email || '').trim().toLowerCase(),
              fullName: memData.fullName || 'an enrolled worker',
              orgId,
              orgName: orgSnap?.data()?.churchName || 'their organization',
              boundAt: memData.registeredAt || new Date().toISOString(),
            };
            await setDoc(
              doc(db, 'device_bindings', cleanDeviceId),
              cleanFirestorePayload(lock),
              { merge: true }
            ).catch(() => {});
          }
        }
      }
    } catch {}

    if (lock && lock.orgId && lock.memberId) {
      // Verify whether the member & org still exist in Firestore and are still bound to this device
      let stillActiveInCloud = true;
      let resolvedOrgName = lock.orgName || 'their organization';
      let resolvedFullName = lock.fullName || 'an enrolled worker';
      let resolvedEmail = (lock.email || '').trim().toLowerCase();

      try {
        const [orgSnap, memberSnap] = await Promise.all([
          getDoc(doc(db, 'churches', lock.orgId)),
          getDoc(doc(db, 'churches', lock.orgId, 'members', lock.memberId)),
        ]);

        if (!orgSnap.exists() || !memberSnap.exists()) {
          // Admin deleted the worker or organization -> release the phone!
          stillActiveInCloud = false;
        } else {
          const orgData = orgSnap.data();
          const memData = memberSnap.data();
          resolvedOrgName = orgData.churchName || resolvedOrgName;
          resolvedFullName = memData.fullName || resolvedFullName;
          resolvedEmail = (memData.email || resolvedEmail).trim().toLowerCase();
          const currentBoundDevice = (memData.boundDeviceId || '').trim();

          if (
            !currentBoundDevice ||
            currentBoundDevice === 'UNBOUND' ||
            currentBoundDevice !== cleanDeviceId
          ) {
            // Admin released/unbound this phone!
            stillActiveInCloud = false;
          }
        }
      } catch {
        // Offline fallback: trust local lock
      }

      if (!stillActiveInCloud) {
        await clearDeviceWorkerLock(cleanDeviceId);
        await clearLocalFaceVault(lock.email, lock.memberId);
        await AsyncStorage.multiRemove([
          STORAGE_KEY_ORG,
          STORAGE_KEY_ANCHORS,
          STORAGE_KEY_MEMBER,
        ]).catch(() => {});
        if (resolvedEmail) {
          await deleteDoc(doc(db, 'account_roles', resolvedEmail)).catch(() => {});
        }
      } else {
        // Refresh local lock metadata
        await AsyncStorage.setItem(
          STORAGE_KEY_DEVICE_WORKER_LOCK,
          JSON.stringify({
            ...lock,
            orgName: resolvedOrgName,
            fullName: resolvedFullName,
            email: resolvedEmail,
          })
        ).catch(() => {});

        // Rule 1A: Block any OTHER worker account from signing in or creating an account on this bound phone
        if (cleanEmail && resolvedEmail && cleanEmail !== resolvedEmail) {
          throw new Error(
            'This mobile phone is already bound to another worker account. Only one worker account is allowed per phone.'
          );
        }

        // Rule 1B: Block the bound worker from joining a SECOND organization until deleted by previous Admin
        if (targetOrgId && targetOrgId !== lock.orgId) {
          throw new Error(
            `Your account and phone are still registered under ${resolvedOrgName}. To register under another organization, please contact the ${resolvedOrgName} administrator to delete your worker profile and release your phone first.`
          );
        }
      }
    }
  }

  // 2. Check if candidateEmail is already registered as a worker in account_roles
  if (cleanEmail) {
    try {
      const roleSnap = await getDoc(doc(db, 'account_roles', cleanEmail));
      if (roleSnap.exists()) {
        const roleData = roleSnap.data();
        if (roleData.role === 'WORKER' && roleData.churchId && roleData.memberId) {
          const [orgSnap, memSnap] = await Promise.all([
            getDoc(doc(db, 'churches', roleData.churchId)),
            getDoc(doc(db, 'churches', roleData.churchId, 'members', roleData.memberId)),
          ]);

          if (!orgSnap.exists() || !memSnap.exists()) {
            // Stale account_roles entry — worker or database was deleted; purge all stale caches!
            await deleteDoc(doc(db, 'account_roles', cleanEmail)).catch(() => {});
            await clearDeviceWorkerLock(cleanDeviceId);
            await clearLocalFaceVault(cleanEmail, roleData.memberId);
            await AsyncStorage.multiRemove([
              STORAGE_KEY_ORG,
              STORAGE_KEY_ANCHORS,
              STORAGE_KEY_MEMBER,
            ]).catch(() => {});
          } else {
            const orgName = orgSnap.data()?.churchName || 'your organization';
            const memData = memSnap.data();
            const boundDev = (memData?.boundDeviceId || '').trim();

            // If worker is already bound to a DIFFERENT phone, block sign-in on this phone
            if (
              boundDev &&
              boundDev !== 'UNBOUND' &&
              cleanDeviceId &&
              boundDev !== cleanDeviceId
            ) {
              throw new Error(
                'This email is already bound to another mobile phone. Please use your registered phone or contact your administrator to release your device.'
              );
            }

            // If worker tries to pair/join a DIFFERENT organization while still active in their current org, block!
            if (targetOrgId && targetOrgId !== roleData.churchId) {
              throw new Error(
                `Your worker account (${cleanEmail}) is still registered under ${orgName}. Please contact the ${orgName} administrator to delete your worker account before enrolling in another organization.`
              );
            }
          }
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('already bound') ||
          err.message.includes('still registered'))
      ) {
        throw err;
      }
    }
  }
}

// Uploads face photo to Firebase Storage or validates payload size limits
export async function sanitizeOrUploadFacePhoto(
  orgId: string,
  memberId: string,
  rawPhoto?: string
): Promise<string | undefined> {
  if (!rawPhoto) return undefined;

  const trimmed = rawPhoto.trim();
  if (!trimmed) return undefined;

  // 1. External or Firebase Storage URL (e.g., https://...)
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }

  // 2. Data URI (data:image/...)
  // Prefer keeping compact inline base64 data URIs (< 950,000 chars) directly on the
  // member document so 1-to-1 AI verification has instant zero-latency access without
  // failing on React Native Hermes Blob/Storage issues.
  if (trimmed.startsWith('data:image/')) {
    if (trimmed.length < 950000) {
      return trimmed;
    }

    if (storage) {
      try {
        const fileRef = storageRef(storage, `churches/${orgId}/members/${memberId}/face_avatar.jpg`);
        await uploadString(fileRef, trimmed, 'data_url');
        const downloadUrl = await getDownloadURL(fileRef);
        return downloadUrl;
      } catch (storageErr) {
        console.warn('Firebase Storage upload failed or not enabled:', storageErr);
      }
    }

    console.warn(`Face photo data URL is too large (${trimmed.length} bytes).`);
    return undefined;
  }

  return trimmed.length < 950000 ? trimmed : undefined;
}

export async function fetchOrganizationByCode(rawCode: string): Promise<Organization | null> {
  const cleanCode = rawCode.trim().toUpperCase();
  if (!cleanCode) return null;

  try {
    const q = query(collection(db, 'churches'), where('churchCode', '==', cleanCode));
    const snapshot = await getDocs(q);

    if (snapshot.empty) {
      return null;
    }

    const docSnap = snapshot.docs[0];
    const data = docSnap.data();

    const org: Organization = {
      id: docSnap.id,
      churchName: data.churchName || 'Organization',
      branchName: data.branchName || 'Main Campus',
      churchCode: data.churchCode || cleanCode,
      departments: Array.isArray(data.departments) && data.departments.length > 0
        ? data.departments
        : ['General Workforce'],
      beaconConfig: {
        ssidHint: data.beaconConfig?.ssidHint || '',
        targetBssid: data.beaconConfig?.targetBssid || '',
        verificationMode: data.beaconConfig?.verificationMode || (data.beaconConfig?.targetBssid ? 'HYBRID' : 'GEOFENCE_ONLY'),
      },
      geoFallback: {
        latitude: Number(data.geoFallback?.latitude ?? 0),
        longitude: Number(data.geoFallback?.longitude ?? 0),
        radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
      },
      policySettings: data.policySettings,
    };

    return org;
  } catch (error) {
    console.error('Error fetching organization by code:', error);
    throw error;
  }
}

export async function fetchFreshOrganizationById(orgId: string): Promise<Organization | null> {
  if (!orgId) return null;
  try {
    const docRef = doc(db, 'churches', orgId);
    const snap = await getDoc(docRef);
    if (!snap.exists()) return null;

    const data = snap.data();
    const org: Organization = {
      id: snap.id,
      churchName: data.churchName || 'Organization',
      branchName: data.branchName || 'Main Campus',
      churchCode: data.churchCode || '',
      departments: Array.isArray(data.departments) && data.departments.length > 0
        ? data.departments
        : ['General Workforce'],
      beaconConfig: {
        ssidHint: data.beaconConfig?.ssidHint || '',
        targetBssid: data.beaconConfig?.targetBssid || '',
      },
      geoFallback: {
        latitude: Number(data.geoFallback?.latitude ?? 0),
        longitude: Number(data.geoFallback?.longitude ?? 0),
        radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
      },
      policySettings: data.policySettings,
    };

    await cacheOrganizationAnchors(org);
    return org;
  } catch (error) {
    console.warn('Error fetching fresh organization by ID:', error);
    return null;
  }
}

export function subscribeToOrganization(
  orgId: string,
  onUpdate: (org: Organization) => void,
  onError?: (err: any) => void
): () => void {
  if (!orgId) return () => {};
  const docRef = doc(db, 'churches', orgId);
  return onSnapshot(
    docRef,
    (snap) => {
      if (!snap.exists()) return;
      const data = snap.data();
      const org: Organization = {
        id: snap.id,
        churchName: data.churchName || 'Organization',
        branchName: data.branchName || 'Main Campus',
        churchCode: data.churchCode || '',
        departments: Array.isArray(data.departments) && data.departments.length > 0
          ? data.departments
          : ['General Workforce'],
        beaconConfig: {
          ssidHint: data.beaconConfig?.ssidHint || '',
          targetBssid: data.beaconConfig?.targetBssid || '',
        },
        geoFallback: {
          latitude: Number(data.geoFallback?.latitude ?? 0),
          longitude: Number(data.geoFallback?.longitude ?? 0),
          radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
        },
        policySettings: data.policySettings,
      };
      cacheOrganizationAnchors(org).catch(() => {});
      onUpdate(org);
    },
    (err) => {
      console.warn('subscribeToOrganization snapshot listener error:', err);
      if (onError) onError(err);
    }
  );
}

export async function cacheOrganizationAnchors(org: Organization): Promise<CachedAnchors> {
  const mode = org.beaconConfig?.verificationMode || (org.beaconConfig?.targetBssid ? 'HYBRID' : 'GEOFENCE_ONLY');
  const anchors: CachedAnchors = {
    churchId: org.id,
    churchName: org.churchName,
    branchName: org.branchName,
    churchCode: org.churchCode,
    ssidHint: org.beaconConfig?.ssidHint || '',
    targetBssid: org.beaconConfig?.targetBssid || '',
    latitude: org.geoFallback.latitude,
    longitude: org.geoFallback.longitude,
    radiusMeters: org.geoFallback.radiusMeters,
    verificationMode: mode,
    cachedAt: new Date().toISOString(),
  };

  await AsyncStorage.setItem(STORAGE_KEY_ANCHORS, JSON.stringify(anchors));
  await AsyncStorage.setItem(STORAGE_KEY_ORG, JSON.stringify(org));
  return anchors;
}

export async function getCachedAnchors(): Promise<CachedAnchors | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_ANCHORS);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function getCachedOrganization(): Promise<Organization | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_ORG);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function getCachedMember(): Promise<ChurchMember | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_MEMBER);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Registers or promotes an email/UID to Field Administrator on mobile,
 * provided the email does not belong to an active worker in a live Firestore organization.
 * Automatically purges any stale worker/device cache left over from a cleared database.
 */
export async function promoteEmailToAdminIfNotActiveWorker(params: {
  email: string;
  uid: string;
  displayName?: string;
  deviceId?: string;
}): Promise<void> {
  const cleanEmail = (params.email || '').trim().toLowerCase();
  const uid = (params.uid || '').trim();
  if (!cleanEmail) return;

  // 1. Check if this email is currently an ACTIVE worker in a live Firestore organization
  try {
    const roleSnap = await getDoc(doc(db, 'account_roles', cleanEmail));
    if (roleSnap.exists()) {
      const roleData = roleSnap.data();
      if (roleData.role === 'WORKER' && roleData.churchId && roleData.memberId) {
        const [orgSnap, memSnap] = await Promise.all([
          getDoc(doc(db, 'churches', roleData.churchId)),
          getDoc(doc(db, 'churches', roleData.churchId, 'members', roleData.memberId)),
        ]);
        if (orgSnap.exists() && memSnap.exists()) {
          const orgName = orgSnap.data()?.churchName || 'an active organization';
          throw new Error(
            `This email (${cleanEmail}) is currently registered as a workforce member under ${orgName}. Delete that worker profile first to use this email as an administrator.`
          );
        }
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('currently registered as a workforce member')) {
      throw err;
    }
  }

  // 2. Purge any stale worker records in Firestore & local AsyncStorage
  if (uid) {
    await deleteDoc(doc(db, 'workers', uid)).catch(() => {});
  }
  await clearDeviceWorkerLock(params.deviceId);
  await clearLocalFaceVault(cleanEmail);
  await AsyncStorage.multiRemove([
    STORAGE_KEY_ORG,
    STORAGE_KEY_ANCHORS,
    STORAGE_KEY_MEMBER,
  ]).catch(() => {});

  // 3. Persist ADMIN role in Firestore (admins/{uid} + account_roles/{cleanEmail})
  const writes: Array<Promise<any>> = [
    setDoc(
      doc(db, 'account_roles', cleanEmail),
      {
        email: cleanEmail,
        role: 'ADMIN',
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    ),
  ];
  if (uid) {
    writes.push(
      setDoc(
        doc(db, 'admins', uid),
        {
          uid,
          email: cleanEmail,
          displayName: params.displayName || cleanEmail.split('@')[0],
          role: 'ADMIN',
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      )
    );
  }
  await Promise.all(writes).catch(() => {});
}

// Security Check: Verify whether an email or UID is registered as an organization administrator (parallelized 1-round-trip lookup)
export async function checkIfUserIsAdmin(email?: string, uid?: string): Promise<boolean> {
  const cleanEmail = (email || '').trim().toLowerCase();
  const rawEmail = (email || '').trim();
  if (!cleanEmail && !uid) return false;

  try {
    const [
      roleSnap,
      adminUidSnap,
      snapAdminEmail,
      snapChurchEmail,
      snapChurchRaw,
      snapChurchUids,
      directChurchSnap,
    ] = await Promise.all([
      cleanEmail ? getDoc(doc(db, 'account_roles', cleanEmail)).catch(() => null) : Promise.resolve(null),
      uid ? getDoc(doc(db, 'admins', uid)).catch(() => null) : Promise.resolve(null),
      cleanEmail
        ? getDocs(query(collection(db, 'admins'), where('email', '==', cleanEmail), limit(1))).catch(() => null)
        : Promise.resolve(null),
      cleanEmail
        ? getDocs(query(collection(db, 'churches'), where('adminEmail', '==', cleanEmail), limit(1))).catch(() => null)
        : Promise.resolve(null),
      rawEmail && rawEmail !== cleanEmail
        ? getDocs(query(collection(db, 'churches'), where('adminEmail', '==', rawEmail), limit(1))).catch(() => null)
        : Promise.resolve(null),
      uid
        ? getDocs(query(collection(db, 'churches'), where('adminUids', 'array-contains', uid), limit(1))).catch(() => null)
        : Promise.resolve(null),
      uid ? getDoc(doc(db, 'churches', uid)).catch(() => null) : Promise.resolve(null),
    ]);

    if (roleSnap?.exists() && roleSnap.data()?.role === 'ADMIN') {
      return true;
    }

    const matchedChurchId =
      snapChurchEmail && !snapChurchEmail.empty
        ? snapChurchEmail.docs[0].id
        : snapChurchRaw && !snapChurchRaw.empty
        ? snapChurchRaw.docs[0].id
        : snapChurchUids && !snapChurchUids.empty
        ? snapChurchUids.docs[0].id
        : directChurchSnap?.exists()
        ? uid
        : undefined;

    if (adminUidSnap?.exists() || (snapAdminEmail && !snapAdminEmail.empty) || matchedChurchId) {
      if (cleanEmail) {
        setDoc(
          doc(db, 'account_roles', cleanEmail),
          {
            email: cleanEmail,
            role: 'ADMIN',
            ...(matchedChurchId ? { churchId: matchedChurchId } : {}),
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        ).catch(() => {});
      }
      return true;
    }

    // Background cleanup if account_roles points to a deleted worker/org
    if (cleanEmail && roleSnap?.exists() && roleSnap.data()?.role === 'WORKER') {
      const data = roleSnap.data();
      if (data.churchId && data.memberId) {
        Promise.all([
          getDoc(doc(db, 'churches', data.churchId)),
          getDoc(doc(db, 'churches', data.churchId, 'members', data.memberId)),
        ])
          .then(([orgSnap, memSnap]) => {
            if (!orgSnap.exists() || !memSnap.exists()) {
              deleteDoc(doc(db, 'account_roles', cleanEmail)).catch(() => {});
              clearDeviceWorkerLock().catch(() => {});
              AsyncStorage.multiRemove([
                STORAGE_KEY_ORG,
                STORAGE_KEY_ANCHORS,
                STORAGE_KEY_MEMBER,
              ]).catch(() => {});
            }
          })
          .catch(() => {});
      } else {
        deleteDoc(doc(db, 'account_roles', cleanEmail)).catch(() => {});
      }
    }

    return false;
  } catch (err) {
    console.warn('checkIfUserIsAdmin error:', err);
    return false;
  }
}

export async function registerMember(
  orgId: string,
  memberData: {
    fullName: string;
    phone: string;
    email?: string;
    photoURL?: string;
    department: string;
    boundDeviceId: string;
    faceEmbedding?: number[];
    facePhotoURL?: string;
    isFaceEnrolled?: boolean;
    assignedShiftId?: string;
    assignedShiftName?: string;
  }
): Promise<ChurchMember> {
  try {
    const membersRef = collection(db, 'churches', orgId, 'members');
    const cleanEmail = (memberData.email || '').trim().toLowerCase();

    // 0. Security Guard: Prevent administrators from registering as workforce members
    let orgName = 'Organization';
    const orgDoc = await getDoc(doc(db, 'churches', orgId));
    if (orgDoc.exists()) {
      const orgData = orgDoc.data();
      orgName = orgData.churchName || orgName;
      if (
        cleanEmail &&
        ((orgData.adminEmail && orgData.adminEmail.toLowerCase() === cleanEmail) ||
          (Array.isArray(orgData.adminUids) && orgData.adminUids.includes(cleanEmail)))
      ) {
        throw new Error(
          `This account (${cleanEmail}) is registered as an organization administrator on the web portal. Administrator accounts cannot be registered as workforce members on the mobile app. Please sign in with a designated workforce account.`
        );
      }
    }

    // 0b. Global & Local 1-Worker-1-Phone + 1-Org Lock Check
    await enforceDeviceWorkerLock({
      deviceId: memberData.boundDeviceId,
      candidateEmail: cleanEmail,
      targetOrgId: orgId,
    });

    // 1. Silent Background Check: Is this physical hardware already bound to someone else in this org?
    if (memberData.boundDeviceId) {
      const qDevice = query(membersRef, where('boundDeviceId', '==', memberData.boundDeviceId));
      const snapDevice = await getDocs(qDevice);
      if (!snapDevice.empty) {
        for (const d of snapDevice.docs) {
          const bound = d.data();
          const boundEmail = (bound.email || '').trim().toLowerCase();
          if (boundEmail && cleanEmail && boundEmail !== cleanEmail) {
            throw new Error(
              'This mobile phone is already bound to another worker account. Only one worker account is allowed per phone.'
            );
          }
        }
      }
    }

    // 2. Check if a member with this email already exists
    if (cleanEmail) {
      const qEmail = query(membersRef, where('email', '==', cleanEmail));
      const snapEmail = await getDocs(qEmail);
      if (!snapEmail.empty) {
        const existingDoc = snapEmail.docs[0];
        const existingMember = { id: existingDoc.id, ...existingDoc.data() } as ChurchMember;
        const existingBoundDev = (existingMember.boundDeviceId || '').trim();

        if (
          existingBoundDev &&
          existingBoundDev !== 'UNBOUND' &&
          existingBoundDev !== memberData.boundDeviceId
        ) {
          throw new Error(
            'This email is already bound to another mobile phone. Please use your registered phone or contact your administrator to release your device.'
          );
        }

        const updatesToApply: Record<string, any> = {};
        if (
          (!existingBoundDev || existingBoundDev === 'UNBOUND') &&
          memberData.boundDeviceId
        ) {
          existingMember.boundDeviceId = memberData.boundDeviceId;
          updatesToApply.boundDeviceId = memberData.boundDeviceId;
        }

        if (memberData.faceEmbedding && memberData.faceEmbedding.length > 0) {
          existingMember.faceEmbedding = memberData.faceEmbedding;
          existingMember.isFaceEnrolled = true;
          existingMember.faceEnrolledAt = new Date().toISOString();
          updatesToApply.faceEmbedding = memberData.faceEmbedding;
          updatesToApply.isFaceEnrolled = true;
          updatesToApply.faceEnrolledAt = existingMember.faceEnrolledAt;
          if (memberData.facePhotoURL) {
            // Save immediately to On-Device Face Vault for instant offline/local verification
            await saveFaceToLocalVault({
              facePhotoURL: memberData.facePhotoURL,
              faceEmbedding: memberData.faceEmbedding,
              faceEnrolledAt: existingMember.faceEnrolledAt,
              email: cleanEmail,
              memberId: existingMember.id,
              orgId,
            });
            const sanitizedPhoto = await sanitizeOrUploadFacePhoto(
              orgId,
              existingMember.id,
              memberData.facePhotoURL
            );
            existingMember.facePhotoURL = sanitizedPhoto || memberData.facePhotoURL;
            if (sanitizedPhoto) {
              updatesToApply.facePhotoURL = sanitizedPhoto;
            }
          }
        }

        if (Object.keys(updatesToApply).length > 0) {
          await updateDoc(doc(db, 'churches', orgId, 'members', existingMember.id), cleanFirestorePayload(updatesToApply));
        }

        await hydrateMemberWithLocalFaceVault(existingMember, orgId);
        if (memberData.boundDeviceId) {
          await saveDeviceWorkerLock({
            deviceId: memberData.boundDeviceId,
            memberId: existingMember.id,
            email: cleanEmail,
            fullName: existingMember.fullName,
            orgId,
            orgName,
            boundAt: new Date().toISOString(),
          });
        }
        await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(existingMember));
        return existingMember;
      }
    }

    const memberId = 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const enrolledAt = new Date().toISOString();

    // 1. Save face to On-Device Face Vault FIRST so local storage always has the reference photo
    if (memberData.facePhotoURL) {
      await saveFaceToLocalVault({
        facePhotoURL: memberData.facePhotoURL,
        faceEmbedding: memberData.faceEmbedding,
        faceEnrolledAt: enrolledAt,
        email: cleanEmail,
        memberId,
        orgId,
      });
    }

    const sanitizedFacePhoto = memberData.facePhotoURL
      ? await sanitizeOrUploadFacePhoto(orgId, memberId, memberData.facePhotoURL)
      : undefined;

    const newMember: ChurchMember = {
      id: memberId,
      fullName: memberData.fullName.trim(),
      phone: memberData.phone.trim(),
      email: memberData.email?.trim().toLowerCase() || undefined,
      photoURL: memberData.photoURL?.trim() || undefined,
      department: memberData.department,
      boundDeviceId: memberData.boundDeviceId,
      ...(memberData.assignedShiftId ? { assignedShiftId: memberData.assignedShiftId } : {}),
      ...(memberData.assignedShiftName ? { assignedShiftName: memberData.assignedShiftName } : {}),
      registeredAt: enrolledAt,
      ...(memberData.faceEmbedding && memberData.faceEmbedding.length > 0
        ? {
            faceEmbedding: memberData.faceEmbedding,
            isFaceEnrolled: true,
            faceEnrolledAt: enrolledAt,
            facePhotoURL: sanitizedFacePhoto || memberData.facePhotoURL,
          }
        : {
            isFaceEnrolled: false,
          }),
    };

    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    await setDoc(memberDocRef, cleanFirestorePayload(newMember));

    // Register worker role in account_roles registry
    if (cleanEmail) {
      try {
        await setDoc(
          doc(db, 'account_roles', cleanEmail),
          {
            email: cleanEmail,
            role: 'WORKER',
            churchId: orgId,
            memberId: memberId,
            updatedAt: new Date().toISOString(),
          },
          { merge: true }
        );
      } catch (roleErr) {
        console.warn('Could not record worker role in account_roles:', roleErr);
      }
    }

    // Lock this physical phone to this worker account & organization
    if (memberData.boundDeviceId) {
      await saveDeviceWorkerLock({
        deviceId: memberData.boundDeviceId,
        memberId,
        email: cleanEmail,
        fullName: newMember.fullName,
        orgId,
        orgName,
        boundAt: enrolledAt,
      });
    }

    await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(newMember));
    return newMember;
  } catch (error) {
    console.error('Error registering member:', error);
    throw error;
  }
}

export async function updateMemberFaceEnrollment(
  orgId: string,
  memberId: string,
  faceEmbedding: number[],
  facePhotoURL?: string
): Promise<void> {
  try {
    const enrolledAt = new Date().toISOString();
    const cached = await getCachedMember();

    // 1. Save immediately to On-Device Face Vault for instant local verification
    if (facePhotoURL) {
      await saveFaceToLocalVault({
        facePhotoURL,
        faceEmbedding,
        faceEnrolledAt: enrolledAt,
        email: cached?.id === memberId ? cached.email : undefined,
        memberId,
        orgId,
      });
    }

    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    const sanitizedFacePhoto = facePhotoURL
      ? await sanitizeOrUploadFacePhoto(orgId, memberId, facePhotoURL)
      : undefined;

    const updates: Record<string, any> = {
      faceEmbedding,
      isFaceEnrolled: true,
      faceEnrolledAt: enrolledAt,
      faceResetByAdminAt: '',
    };
    if (sanitizedFacePhoto) {
      updates.facePhotoURL = sanitizedFacePhoto;
    }

    await updateDoc(memberDocRef, cleanFirestorePayload(updates));

    // Update local cache
    if (cached && cached.id === memberId) {
      const updatedMember: ChurchMember = {
        ...cached,
        faceEmbedding,
        isFaceEnrolled: true,
        faceEnrolledAt: updates.faceEnrolledAt,
        ...(facePhotoURL ? { facePhotoURL } : {}),
      };
      await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(updatedMember));
    }
  } catch (error) {
    console.error('Error updating member face enrollment:', error);
    throw error;
  }
}

export async function clearMemberFaceEnrollment(orgId: string, memberId: string): Promise<void> {
  try {
    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    const snap = await getDoc(memberDocRef).catch(() => null);
    const memberEmail = snap?.exists() ? snap.data()?.email : undefined;

    await updateDoc(memberDocRef, {
      faceEmbedding: [],
      isFaceEnrolled: false,
      faceEnrolledAt: '',
      facePhotoURL: '',
      faceResetByAdminAt: new Date().toISOString(),
    });

    const cached = await getCachedMember();
    if (cached && cached.id === memberId) {
      await clearLocalFaceVault(cached.email || memberEmail, memberId);
      cached.faceEmbedding = [];
      cached.isFaceEnrolled = false;
      delete cached.faceEnrolledAt;
      delete cached.facePhotoURL;
      await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(cached));
    }
  } catch (error) {
    console.error('Error clearing member face enrollment:', error);
    throw error;
  }
}

export async function resetMemberDeviceBinding(orgId: string, memberId: string): Promise<void> {
  try {
    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    const snap = await getDoc(memberDocRef).catch(() => null);
    const oldDeviceId = snap?.exists() ? snap.data()?.boundDeviceId : undefined;

    await updateDoc(memberDocRef, {
      boundDeviceId: '',
    });

    if (oldDeviceId && oldDeviceId !== 'UNBOUND') {
      await deleteDoc(doc(db, 'device_bindings', oldDeviceId)).catch(() => {});
    }
  } catch (error) {
    console.error('Error resetting member device binding:', error);
    throw error;
  }
}

export async function updateMemberStatus(
  orgId: string,
  memberId: string,
  status: 'ACTIVE' | 'SUSPENDED'
): Promise<void> {
  try {
    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    await updateDoc(memberDocRef, {
      status,
      ...(status === 'ACTIVE' ? { flagReason: null } : {}),
      statusUpdatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Error updating member status:', error);
    throw error;
  }
}

/**
 * Checks device clock against authoritative HTTP Date header (2.5s timeout).
 * Flags tampering if device time differs by >3 minutes; skips cleanly when offline.
 */
export async function verifyNetworkClockIntegrity(): Promise<{
  ok: boolean;
  driftMinutes?: number;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const res = await fetch('https://www.google.com/generate_204', {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const dateHdr = res.headers.get('date');
    if (!dateHdr) return { ok: true };
    const serverMs = Date.parse(dateHdr);
    if (Number.isNaN(serverMs)) return { ok: true };
    const driftMs = Math.abs(Date.now() - serverMs);
    if (driftMs > 3 * 60 * 1000) {
      return { ok: false, driftMinutes: Math.round(driftMs / 60_000) };
    }
    return { ok: true };
  } catch {
    clearTimeout(timer);
    return { ok: true };
  }
}

export async function flagAndSuspendForClockTampering(
  orgId: string,
  memberId: string,
  driftMinutes: number
): Promise<void> {
  try {
    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    await updateDoc(memberDocRef, {
      status: 'SUSPENDED',
      flagReason: `Device clock tampering detected (${driftMinutes}m drift from network time).`,
      flaggedAt: new Date().toISOString(),
      statusUpdatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.warn('Could not flag clock tampering:', err);
  }
}

export async function deleteOrganizationMember(orgId: string, memberId: string): Promise<void> {
  try {
    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    const snap = await getDoc(memberDocRef).catch(() => null);
    const memData = snap?.exists() ? snap.data() : null;

    await deleteDoc(memberDocRef);

    if (memData?.boundDeviceId && memData.boundDeviceId !== 'UNBOUND') {
      await deleteDoc(doc(db, 'device_bindings', memData.boundDeviceId)).catch(() => {});
    }
    if (memData?.email) {
      const cleanEmail = String(memData.email).trim().toLowerCase();
      if (cleanEmail) {
        await deleteDoc(doc(db, 'account_roles', cleanEmail)).catch(() => {});
      }
    }
  } catch (error) {
    console.error('Error deleting member:', error);
    throw error;
  }
}

export async function findExistingMember(orgId: string, email?: string, deviceId?: string): Promise<ChurchMember | null> {
  try {
    const membersRef = collection(db, 'churches', orgId, 'members');
    const cleanEmail = (email || '').trim().toLowerCase();

    // Enforce global & local 1-Worker-1-Phone lock before resolving member
    await enforceDeviceWorkerLock({
      deviceId,
      candidateEmail: cleanEmail,
    });

    // Parallelize queries with limit(1) to eliminate sequential network round trips
    const [snapEmail, snapDevice, orgSnap] = await Promise.all([
      cleanEmail
        ? getDocs(query(membersRef, where('email', '==', cleanEmail), limit(1)))
        : Promise.resolve(null),
      deviceId
        ? getDocs(query(membersRef, where('boundDeviceId', '==', deviceId), limit(1)))
        : Promise.resolve(null),
      getDoc(doc(db, 'churches', orgId)).catch(() => null),
    ]);
    const orgName = orgSnap?.exists() ? orgSnap.data()?.churchName || 'this organization' : 'this organization';

    // 1. If device is already bound in this organization to a DIFFERENT worker email, block immediately!
    if (snapDevice && !snapDevice.empty) {
      const boundDoc = snapDevice.docs[0];
      const bound = boundDoc.data();
      const boundEmail = (bound.email || '').trim().toLowerCase();
      if (cleanEmail && boundEmail && boundEmail !== cleanEmail) {
        throw new Error(
          'This mobile phone is already bound to another worker account. Only one worker account is allowed per phone.'
        );
      }
    }

    // 2. Primary check: Email match (highest fidelity account identity)
    if (snapEmail && !snapEmail.empty) {
      const d = snapEmail.docs[0];
      const member = { id: d.id, ...d.data() } as ChurchMember;
      const boundDev = (member.boundDeviceId || '').trim();

      // Verify device binding
      if (boundDev && boundDev !== 'UNBOUND' && deviceId && boundDev !== deviceId) {
        throw new Error(
          'This email is already bound to another mobile phone. Please use your registered phone or contact your administrator to release your device.'
        );
      }

      // If member exists but device is not yet bound (or was unbound by admin), bind it now
      if ((!boundDev || boundDev === 'UNBOUND') && deviceId) {
        member.boundDeviceId = deviceId;
        updateDoc(doc(db, 'churches', orgId, 'members', member.id), {
          boundDeviceId: deviceId,
        }).catch((updateErr) => console.warn('Could not update device binding on existing member:', updateErr));
      }

      // Hydrate face directly from On-Device Face Vault (0ms local storage restoration!)
      await hydrateMemberWithLocalFaceVault(member, orgId);

      if (deviceId) {
        await saveDeviceWorkerLock({
          deviceId,
          memberId: member.id,
          email: cleanEmail || (member.email || '').toLowerCase(),
          fullName: member.fullName,
          orgId,
          orgName,
          boundAt: new Date().toISOString(),
        });
      }

      AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(member)).catch(() => {});
      return member;
    }

    // 3. Secondary check: Bound device match
    if (snapDevice && !snapDevice.empty) {
      const d = snapDevice.docs[0];
      const bound = d.data();
      const member = { id: d.id, ...bound } as ChurchMember;

      await hydrateMemberWithLocalFaceVault(member, orgId);

      if (deviceId) {
        await saveDeviceWorkerLock({
          deviceId,
          memberId: member.id,
          email: (member.email || cleanEmail).toLowerCase(),
          fullName: member.fullName,
          orgId,
          orgName,
          boundAt: new Date().toISOString(),
        });
      }

      AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(member)).catch(() => {});
      return member;
    }

    return null;
  } catch (error) {
    // Re-throw security collision errors so they surface to the user and block unauthorized login
    if (
      error instanceof Error &&
      (error.message.includes('already bound') ||
        error.message.includes('still registered') ||
        error.message.includes('Only one worker'))
    ) {
      throw error;
    }
    console.warn('Could not query existing member:', error);
    return null;
  }
}

// Recursively strips undefined values and oversized fields from Firestore payloads
function cleanFirestorePayload<T>(data: T): T {
  if (data === null || data === undefined) {
    return null as any;
  }
  if (Array.isArray(data)) {
    return data
      .filter((item) => item !== undefined)
      .map((item) => cleanFirestorePayload(item)) as any;
  }
  if (typeof data === 'object' && !(data instanceof Date)) {
    const clean: Record<string, any> = {};
    for (const [key, value] of Object.entries(data as Record<string, any>)) {
      if (value !== undefined) {
        if (typeof value === 'object' && value !== null && !(value instanceof Date)) {
          clean[key] = cleanFirestorePayload(value);
        } else if (typeof value === 'string' && value.length > 960000) {
          // Guard: String size exceeds safe limit (1,048,487 bytes limit on Firestore)
          console.warn(`Dropped property "${key}" from Firestore payload because size (${value.length} bytes) exceeds limit.`);
        } else {
          clean[key] = value;
        }
      }
    }
    return clean as any;
  }
  return data;
}

export async function recordAttendance(orgId: string, input: AttendanceRecordInput): Promise<string> {
  try {
    const cleanPayload = cleanFirestorePayload(input);
    const attCollection = collection(db, 'churches', orgId, 'attendance');
    const docRef = await addDoc(attCollection, cleanPayload);
    return docRef.id;
  } catch (error) {
    console.error('Error logging attendance record:', error);
    throw error;
  }
}

// Updates an attendance record with member sign-out timestamp
export async function recordSignOut(
  orgId: string,
  memberId: string,
  serviceDate: string,
  payload: { signedOutAt: string; signOutDisplayTime: string },
  attendanceDocId?: string
): Promise<boolean> {
  try {
    const clean = cleanFirestorePayload(payload);
    if (attendanceDocId) {
      await updateDoc(doc(db, 'churches', orgId, 'attendance', attendanceDocId), clean);
      return true;
    }

    const attRef = collection(db, 'churches', orgId, 'attendance');
    const q = query(
      attRef,
      where('memberId', '==', memberId),
      where('serviceDate', '==', serviceDate),
      limit(1)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      await updateDoc(doc(db, 'churches', orgId, 'attendance', snap.docs[0].id), clean);
      return true;
    }
    return false;
  } catch (error) {
    console.warn('Error recording sign out in cloud:', error);
    throw error;
  }
}

// Flushes offline-cached punches and sign-outs to cloud
export async function flushPendingAttendanceQueue(orgId: string): Promise<number> {
  try {
    const allKeys = await AsyncStorage.getAllKeys();
    const punchKeys = allKeys.filter((k) => k.startsWith('@sanctuary_punch_'));
    let syncedCount = 0;

    for (const key of punchKeys) {
      try {
        const raw = await AsyncStorage.getItem(key);
        if (!raw) continue;
        const punch: import('../types').TodayPunchRecord = JSON.parse(raw);

        // 1. If punch clock-in was cached offline, push clock-in
        if (punch.status === 'OFFLINE_CACHED') {
          const docId = await recordAttendance(orgId, {
            memberId: punch.memberId,
            memberName: 'Team Member',
            department: 'General Workforce',
            serviceDate: punch.serviceDate,
            timestamp: punch.punchedAt,
            punchedAt: punch.punchedAt,
            syncedAt: new Date().toISOString(),
            verificationMethod: punch.verificationMethod || 'WIFI_BSSID',
            status: punch.attendanceStatus || 'ON_TIME',
            deviceId: '',
            ...(punch.signedOutAt ? { signedOutAt: punch.signedOutAt, signOutDisplayTime: punch.signOutDisplayTime } : {}),
            ...(punch.bssidDetected ? { bssidDetected: punch.bssidDetected } : {}),
          });

          punch.status = 'SYNCED';
          punch.attendanceDocId = docId;
          if (punch.signedOutAt) {
            punch.signOutStatus = 'SYNCED';
          }
          await AsyncStorage.setItem(key, JSON.stringify(punch));
          syncedCount++;
        }
        // 2. If clock-in was synced but sign-out was cached offline, push sign-out
        else if (punch.signOutStatus === 'OFFLINE_CACHED' && punch.signedOutAt) {
          await recordSignOut(
            orgId,
            punch.memberId,
            punch.serviceDate,
            {
              signedOutAt: punch.signedOutAt,
              signOutDisplayTime: punch.signOutDisplayTime || '',
            },
            punch.attendanceDocId
          );
          punch.signOutStatus = 'SYNCED';
          await AsyncStorage.setItem(key, JSON.stringify(punch));
          syncedCount++;
        }
      } catch (itemErr) {
        console.warn('Could not sync queued punch item:', key, itemErr);
      }
    }
    return syncedCount;
  } catch (err) {
    console.warn('flushPendingAttendanceQueue failed:', err);
    return 0;
  }
}

export async function getTodayPunchRecord(
  memberId: string,
  serviceDate: string
): Promise<import('../types').TodayPunchRecord | null> {
  try {
    const key = `@sanctuary_punch_${memberId}_${serviceDate}`;
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveTodayPunchRecord(
  record: import('../types').TodayPunchRecord
): Promise<void> {
  try {
    const key = `@sanctuary_punch_${record.memberId}_${record.serviceDate}`;
    await AsyncStorage.setItem(key, JSON.stringify(record));
  } catch (e) {
    console.warn('Could not cache punch locally:', e);
  }
}

export async function clearTodayPunchRecord(
  memberId: string,
  serviceDate: string
): Promise<void> {
  try {
    const key = `@sanctuary_punch_${memberId}_${serviceDate}`;
    await AsyncStorage.removeItem(key);
  } catch (e) {
    console.warn('Could not clear cached punch:', e);
  }
}

export async function fetchTodayMemberAttendance(
  orgId: string,
  memberId: string,
  serviceDate: string
): Promise<any | null> {
  try {
    const attRef = collection(db, 'churches', orgId, 'attendance');
    const q = query(
      attRef,
      where('memberId', '==', memberId),
      where('serviceDate', '==', serviceDate)
    );
    const snap = await getDocs(q);
    if (!snap.empty) {
      const docSnap = snap.docs[0];
      return { id: docSnap.id, ...docSnap.data() };
    }
    return null;
  } catch (e) {
    console.warn('Could not check today attendance on cloud:', e);
    return null;
  }
}

export async function getAdminOrganization(
  email?: string,
  uid?: string
): Promise<Organization | null> {
  const cleanEmail = (email || '').trim().toLowerCase();
  if (!cleanEmail && !uid) return null;

  // 0. If an organization is cached locally, verify it STILL exists in Firestore before returning it
  try {
    const cachedOrg = await getCachedOrganization();
    if (cachedOrg && cachedOrg.id) {
      const freshSnap = await getDoc(doc(db, 'churches', cachedOrg.id));
      if (!freshSnap.exists()) {
        // Organization was deleted from Firestore -> purge local cache immediately!
        await AsyncStorage.multiRemove([STORAGE_KEY_ORG, STORAGE_KEY_ANCHORS]).catch(() => {});
      } else if (
        (cleanEmail && cachedOrg.adminEmail && cachedOrg.adminEmail.toLowerCase() === cleanEmail) ||
        (uid && Array.isArray(cachedOrg.adminUids) && cachedOrg.adminUids.includes(uid)) ||
        (uid && cachedOrg.id === uid)
      ) {
        const data = freshSnap.data();
        const freshOrg: Organization = {
          id: freshSnap.id,
          churchName: data.churchName || cachedOrg.churchName || 'Organization',
          branchName: data.branchName || cachedOrg.branchName || 'Main Campus',
          churchCode: data.churchCode || cachedOrg.churchCode || '',
          adminEmail: data.adminEmail || cleanEmail,
          departments:
            Array.isArray(data.departments) && data.departments.length > 0
              ? data.departments
              : ['General Workforce'],
          beaconConfig: {
            ssidHint: data.beaconConfig?.ssidHint || '',
            targetBssid: data.beaconConfig?.targetBssid || '',
            verificationMode: data.beaconConfig?.verificationMode || 'HYBRID',
          },
          geoFallback: {
            latitude: Number(data.geoFallback?.latitude ?? 0),
            longitude: Number(data.geoFallback?.longitude ?? 0),
            radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
          },
          policySettings: data.policySettings,
        };
        await cacheOrganizationAnchors(freshOrg);
        return freshOrg;
      }
    }
  } catch {}

  // 0.1 Check cached anchors for churchId
  try {
    const cachedAnchors = await getCachedAnchors();
    if (cachedAnchors && cachedAnchors.churchId) {
      const orgSnap = await getDoc(doc(db, 'churches', cachedAnchors.churchId)).catch(() => null);
      if (orgSnap && orgSnap.exists()) {
        const data = orgSnap.data();
        const org: Organization = {
          id: orgSnap.id,
          churchName: data.churchName || cachedAnchors.churchName || 'Organization',
          branchName: data.branchName || cachedAnchors.branchName || 'Main Campus',
          churchCode: data.churchCode || cachedAnchors.churchCode || '',
          adminEmail: data.adminEmail || cleanEmail,
          departments: Array.isArray(data.departments) && data.departments.length > 0
            ? data.departments
            : ['General Workforce'],
          beaconConfig: {
            ssidHint: data.beaconConfig?.ssidHint || cachedAnchors.ssidHint || '',
            targetBssid: data.beaconConfig?.targetBssid || cachedAnchors.targetBssid || '',
            verificationMode: data.beaconConfig?.verificationMode || 'HYBRID',
          },
          geoFallback: {
            latitude: Number(data.geoFallback?.latitude ?? cachedAnchors.latitude ?? 0),
            longitude: Number(data.geoFallback?.longitude ?? cachedAnchors.longitude ?? 0),
            radiusMeters: Number(data.geoFallback?.radiusMeters ?? cachedAnchors.radiusMeters ?? 10),
          },
          policySettings: data.policySettings,
        };
        cacheOrganizationAnchors(org).catch(() => {});
        return org;
      }
    }
  } catch {}

  try {
    if (cleanEmail) {
      const roleRef = doc(db, 'account_roles', cleanEmail);
      const roleSnap = await getDoc(roleRef);
      if (roleSnap.exists()) {
        const roleData = roleSnap.data();
        if (roleData.churchId) {
          const churchSnap = await getDoc(doc(db, 'churches', roleData.churchId));
          if (churchSnap.exists()) {
            const data = churchSnap.data();
            const org: Organization = {
              id: churchSnap.id,
              churchName: data.churchName || 'Organization',
              branchName: data.branchName || 'Main Campus',
              churchCode: data.churchCode || '',
              departments: Array.isArray(data.departments) && data.departments.length > 0
                ? data.departments
                : ['General Workforce'],
              beaconConfig: {
                ssidHint: data.beaconConfig?.ssidHint || '',
                targetBssid: data.beaconConfig?.targetBssid || '',
              },
              geoFallback: {
                latitude: Number(data.geoFallback?.latitude ?? 0),
                longitude: Number(data.geoFallback?.longitude ?? 0),
                radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
              },
              policySettings: data.policySettings,
            };
            cacheOrganizationAnchors(org).catch(() => {});
            return org;
          }
        }
      }
    }

    if (cleanEmail) {
      const q = query(
        collection(db, 'churches'),
        where('adminEmail', '==', cleanEmail),
        limit(1)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        const docSnap = snap.docs[0];
        const data = docSnap.data();
        const org: Organization = {
          id: docSnap.id,
          churchName: data.churchName || 'Organization',
          branchName: data.branchName || 'Main Campus',
          churchCode: data.churchCode || '',
          departments: Array.isArray(data.departments) && data.departments.length > 0
            ? data.departments
            : ['General Workforce'],
          beaconConfig: {
            ssidHint: data.beaconConfig?.ssidHint || '',
            targetBssid: data.beaconConfig?.targetBssid || '',
          },
          geoFallback: {
            latitude: Number(data.geoFallback?.latitude ?? 0),
            longitude: Number(data.geoFallback?.longitude ?? 0),
            radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
          },
          policySettings: data.policySettings,
        };
        cacheOrganizationAnchors(org).catch(() => {});
        return org;
      }
    }

    if (uid) {
      const directSnap = await getDoc(doc(db, 'churches', uid));
      if (directSnap.exists()) {
        const data = directSnap.data();
        const org: Organization = {
          id: directSnap.id,
          churchName: data.churchName || 'Organization',
          branchName: data.branchName || 'Main Campus',
          churchCode: data.churchCode || '',
          departments: Array.isArray(data.departments) && data.departments.length > 0
            ? data.departments
            : ['General Workforce'],
          beaconConfig: {
            ssidHint: data.beaconConfig?.ssidHint || '',
            targetBssid: data.beaconConfig?.targetBssid || '',
          },
          geoFallback: {
            latitude: Number(data.geoFallback?.latitude ?? 0),
            longitude: Number(data.geoFallback?.longitude ?? 0),
            radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
          },
          policySettings: data.policySettings,
        };
        cacheOrganizationAnchors(org).catch(() => {});
        return org;
      }

      const q = query(
        collection(db, 'churches'),
        where('adminUids', 'array-contains', uid),
        limit(1)
      );
      const snap = await getDocs(q);
      if (!snap.empty) {
        const docSnap = snap.docs[0];
        const data = docSnap.data();
        const org: Organization = {
          id: docSnap.id,
          churchName: data.churchName || 'Organization',
          branchName: data.branchName || 'Main Campus',
          churchCode: data.churchCode || '',
          departments: Array.isArray(data.departments) && data.departments.length > 0
            ? data.departments
            : ['General Workforce'],
          beaconConfig: {
            ssidHint: data.beaconConfig?.ssidHint || '',
            targetBssid: data.beaconConfig?.targetBssid || '',
          },
          geoFallback: {
            latitude: Number(data.geoFallback?.latitude ?? 0),
            longitude: Number(data.geoFallback?.longitude ?? 0),
            radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
          },
          policySettings: data.policySettings,
        };
        cacheOrganizationAnchors(org).catch(() => {});
        return org;
      }
    }
    // 5. Final Comprehensive Scan Fallback: Query churches collection with in-memory matching
    try {
      const allChurchesSnap = await getDocs(query(collection(db, 'churches'), limit(25)));
      if (!allChurchesSnap.empty) {
        const foundDoc = allChurchesSnap.docs.find((d) => {
          const data = d.data();
          const docEmail = (data.adminEmail || '').trim().toLowerCase();
          const docUids = Array.isArray(data.adminUids) ? data.adminUids : [];
          return (
            (cleanEmail && docEmail && docEmail === cleanEmail) ||
            (uid && docUids.includes(uid)) ||
            (uid && (d.id === uid || data.ownerId === uid || data.userId === uid))
          );
        }) || null;

        if (foundDoc) {
          const data = foundDoc.data();
          const org: Organization = {
            id: foundDoc.id,
            churchName: data.churchName || 'Organization',
            branchName: data.branchName || 'Main Campus',
            churchCode: data.churchCode || '',
            adminEmail: data.adminEmail || cleanEmail,
            departments: Array.isArray(data.departments) && data.departments.length > 0
              ? data.departments
              : ['General Workforce'],
            beaconConfig: {
              ssidHint: data.beaconConfig?.ssidHint || '',
              targetBssid: data.beaconConfig?.targetBssid || '',
              verificationMode: data.beaconConfig?.verificationMode || 'HYBRID',
            },
            geoFallback: {
              latitude: Number(data.geoFallback?.latitude ?? 0),
              longitude: Number(data.geoFallback?.longitude ?? 0),
              radiusMeters: Number(data.geoFallback?.radiusMeters ?? 10),
            },
            policySettings: data.policySettings,
          };
          cacheOrganizationAnchors(org).catch(() => {});
          return org;
        }
      }
    } catch (fallbackErr) {
      console.warn('getAdminOrganization comprehensive scan error:', fallbackErr);
    }
  } catch (err) {
    console.warn('getAdminOrganization query skipped or error:', err);
  }

  return null;
}

export async function updateOrganizationAnchors(
  churchId: string,
  anchors: {
    ssidHint: string;
    targetBssid: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    verificationMode?: 'HYBRID' | 'GEOFENCE_ONLY';
  }
): Promise<void> {
  const churchRef = doc(db, 'churches', churchId);
  const mode = anchors.verificationMode || (anchors.targetBssid.trim() ? 'HYBRID' : 'GEOFENCE_ONLY');
  await setDoc(
    churchRef,
    {
      beaconConfig: {
        ssidHint: anchors.ssidHint.trim(),
        targetBssid: anchors.targetBssid.trim().toLowerCase(),
        verificationMode: mode,
      },
      geoFallback: {
        latitude: anchors.latitude,
        longitude: anchors.longitude,
        radiusMeters: anchors.radiusMeters,
        isConfigured: true,
        isCalibrated: true,
      },
      isCalibrated: true,
      calibrationSession: {
        status: 'COMPLETED',
        completedAt: new Date().toISOString(),
        mode,
      },
      updatedAt: new Date().toISOString(),
    },
    { merge: true }
  );
}

export async function createAdminOrganization(params: {
  uid: string;
  adminEmail: string;
  adminName: string;
  adminPhone?: string;
  churchName: string;
  branchName: string;
  churchCode: string;
  country?: string;
  state?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  departments: string[];
  policySettings: import('../types').PolicySettings;
}): Promise<Organization> {
  const cleanEmail = (params.adminEmail || '').trim().toLowerCase();
  const cleanCode = params.churchCode.trim().toUpperCase();
  const orgId = params.uid || `org_${Date.now().toString(36)}`;

  const withTimeout = <T>(promise: Promise<T>, ms: number, msg: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) => setTimeout(() => reject(new Error(msg)), ms)),
    ]);

  // Ensure organization code is not already taken (bounded to 4s so slow mobile data never hangs)
  try {
    const codeSnap = await withTimeout(
      getDocs(query(collection(db, 'churches'), where('churchCode', '==', cleanCode), limit(1))),
      4500,
      'Code check timed out'
    );
    if (!codeSnap.empty && codeSnap.docs[0].id !== orgId) {
      throw new Error(`Organization code "${cleanCode}" is already in use. Please regenerate a new code.`);
    }
  } catch (codeErr: any) {
    if (String(codeErr?.message || '').includes('already in use')) {
      throw codeErr;
    }
    // Otherwise proceed (random org code collision is negligible and shouldn't block onboarding)
  }

  const orgPayload: Record<string, any> = {
    churchName: params.churchName.trim(),
    branchName: params.branchName.trim() || 'Main Campus',
    churchCode: cleanCode,
    adminName: params.adminName.trim(),
    adminEmail: cleanEmail,
    adminPhone: (params.adminPhone || '').trim(),
    adminUids: params.uid ? [params.uid] : [],
    country: params.country || 'Nigeria',
    state: params.state || '',
    city: params.city || '',
    departments: params.departments.length > 0 ? params.departments : ['General Workforce'],
    beaconConfig: {
      ssidHint: '',
      targetBssid: '',
      verificationMode: 'GEOFENCE_ONLY',
    },
    geoFallback: {
      latitude: Number(params.latitude ?? 0),
      longitude: Number(params.longitude ?? 0),
      radiusMeters: 30,
      isConfigured: false,
      isCalibrated: false,
    },
    policySettings: params.policySettings,
    isCalibrated: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  await withTimeout(
    Promise.all([
      setDoc(doc(db, 'churches', orgId), cleanFirestorePayload(orgPayload), { merge: true }),
      cleanEmail
        ? setDoc(
            doc(db, 'account_roles', cleanEmail),
            {
              email: cleanEmail,
              role: 'ADMIN',
              churchId: orgId,
              updatedAt: new Date().toISOString(),
            },
            { merge: true }
          ).catch(() => {})
        : Promise.resolve(),
    ]),
    12000,
    'Network connection is slow or offline. Please check your internet and tap Launch Workspace again.'
  );

  const createdOrg: Organization = {
    id: orgId,
    churchName: orgPayload.churchName,
    branchName: orgPayload.branchName,
    churchCode: orgPayload.churchCode,
    adminName: orgPayload.adminName,
    adminEmail: orgPayload.adminEmail,
    adminPhone: orgPayload.adminPhone,
    adminUids: orgPayload.adminUids,
    departments: orgPayload.departments,
    beaconConfig: orgPayload.beaconConfig,
    geoFallback: orgPayload.geoFallback,
    policySettings: orgPayload.policySettings,
    isCalibrated: false,
  };

  await cacheOrganizationAnchors(createdOrg);
  return createdOrg;
}

export async function updateOrganizationSettings(
  orgId: string,
  updates: {
    churchName: string;
    branchName: string;
    departments: string[];
    policySettings: import('../types').PolicySettings;
  }
): Promise<void> {
  const payload = cleanFirestorePayload({
    churchName: updates.churchName.trim(),
    branchName: updates.branchName.trim() || 'Main Campus',
    departments: updates.departments.length > 0 ? updates.departments : ['General Workforce'],
    policySettings: updates.policySettings,
    updatedAt: new Date().toISOString(),
  });

  await setDoc(doc(db, 'churches', orgId), payload, { merge: true });
}

export async function deleteAdminOrganizationWorkspace(
  orgId: string,
  adminEmail?: string
): Promise<void> {
  // Clean up members + attendance subcollections and device_bindings
  try {
    const [memSnap, attSnap] = await Promise.all([
      getDocs(collection(db, 'churches', orgId, 'members')),
      getDocs(collection(db, 'churches', orgId, 'attendance')),
    ]);

    for (const m of memSnap.docs) {
      const mData = m.data();
      if (mData?.boundDeviceId && mData.boundDeviceId !== 'UNBOUND') {
        await deleteDoc(doc(db, 'device_bindings', mData.boundDeviceId)).catch(() => {});
      }
      if (mData?.email) {
        await deleteDoc(doc(db, 'account_roles', String(mData.email).trim().toLowerCase())).catch(() => {});
      }
      await deleteDoc(m.ref).catch(() => {});
    }

    for (const a of attSnap.docs) {
      await deleteDoc(a.ref).catch(() => {});
    }
  } catch (err) {
    console.warn('Subcollection cleanup notice:', err);
  }

  await deleteDoc(doc(db, 'churches', orgId)).catch(() => {});

  if (adminEmail) {
    await deleteDoc(doc(db, 'account_roles', adminEmail.trim().toLowerCase())).catch(() => {});
  }

  await AsyncStorage.multiRemove([
    STORAGE_KEY_ORG,
    STORAGE_KEY_ANCHORS,
    STORAGE_KEY_MEMBER,
  ]).catch(() => {});
}
