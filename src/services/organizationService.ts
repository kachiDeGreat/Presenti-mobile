import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collection,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  addDoc,
  updateDoc,
  getDoc,
  onSnapshot,
  limit,
} from 'firebase/firestore';
import { db } from '../config/firebase';
import type { Organization, CachedAnchors, ChurchMember, AttendanceRecordInput } from '../types';

const STORAGE_KEY_ANCHORS = '@sanctuary_cached_anchors';
const STORAGE_KEY_ORG = '@sanctuary_active_org';
const STORAGE_KEY_MEMBER = '@sanctuary_member_profile';

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

// Security Check: Verify whether an email or UID is registered as an organization administrator on the web portal
export async function checkIfUserIsAdmin(email?: string, uid?: string): Promise<boolean> {
  const cleanEmail = (email || '').trim().toLowerCase();
  const rawEmail = (email || '').trim();
  if (!cleanEmail && !uid) return false;

  // 0. Instant local check: If cached organization or user on device already confirms admin role
  try {
    const [cachedOrgRaw, cachedUserRaw] = await Promise.all([
      AsyncStorage.getItem(STORAGE_KEY_ORG),
      AsyncStorage.getItem('@sanctuary_user'),
    ]);

    if (cachedUserRaw) {
      try {
        const u = JSON.parse(cachedUserRaw);
        if (
          u.isAdmin === true &&
          ((cleanEmail && u.email?.toLowerCase() === cleanEmail) || (uid && u.uid === uid))
        ) {
          return true;
        }
      } catch {}
    }

    if (cachedOrgRaw) {
      try {
        const o = JSON.parse(cachedOrgRaw);
        if (
          (cleanEmail && o.adminEmail && o.adminEmail.toLowerCase() === cleanEmail) ||
          (rawEmail && o.adminEmail && o.adminEmail === rawEmail) ||
          (uid && Array.isArray(o.adminUids) && o.adminUids.includes(uid)) ||
          (uid && o.id === uid)
        ) {
          return true;
        }
      } catch {}
    }
  } catch {}

  // Function to execute Firestore queries to determine admin status
  const executeQuery = async (): Promise<boolean> => {
    // 1. Check account_roles registry
    if (cleanEmail) {
      try {
        const roleRef = doc(db, 'account_roles', cleanEmail);
        const roleSnap = await getDoc(roleRef);
        if (roleSnap.exists()) {
          const data = roleSnap.data();
          if (data.role === 'ADMIN') return true;
        }
      } catch {}
    }

    // 2. Query churches collection by adminEmail (both lowercase and raw casing)
    if (cleanEmail) {
      try {
        const qEmail = query(
          collection(db, 'churches'),
          where('adminEmail', '==', cleanEmail),
          limit(1)
        );
        const snapEmail = await getDocs(qEmail);
        if (!snapEmail.empty) {
          try {
            await setDoc(
              doc(db, 'account_roles', cleanEmail),
              {
                email: cleanEmail,
                role: 'ADMIN',
                churchId: snapEmail.docs[0].id,
                updatedAt: new Date().toISOString(),
              },
              { merge: true }
            );
          } catch {}
          return true;
        }

        if (rawEmail && rawEmail !== cleanEmail) {
          const qRaw = query(
            collection(db, 'churches'),
            where('adminEmail', '==', rawEmail),
            limit(1)
          );
          const snapRaw = await getDocs(qRaw);
          if (!snapRaw.empty) {
            try {
              await setDoc(
                doc(db, 'account_roles', cleanEmail),
                {
                  email: cleanEmail,
                  role: 'ADMIN',
                  churchId: snapRaw.docs[0].id,
                  updatedAt: new Date().toISOString(),
                },
                { merge: true }
              );
            } catch {}
            return true;
          }
        }
      } catch (err) {
        console.warn('Error querying churches by adminEmail:', err);
      }
    }

    // 3. Query churches collection by adminUids
    if (uid) {
      try {
        const qUids = query(
          collection(db, 'churches'),
          where('adminUids', 'array-contains', uid),
          limit(1)
        );
        const snapUids = await getDocs(qUids);
        if (!snapUids.empty) {
          if (cleanEmail) {
            try {
              await setDoc(
                doc(db, 'account_roles', cleanEmail),
                {
                  email: cleanEmail,
                  role: 'ADMIN',
                  churchId: snapUids.docs[0].id,
                  updatedAt: new Date().toISOString(),
                },
                { merge: true }
              );
            } catch {}
          }
          return true;
        }

        // 4. Direct document check churches/{uid}
        const directSnap = await getDoc(doc(db, 'churches', uid));
        if (directSnap.exists()) {
          if (cleanEmail) {
            try {
              await setDoc(
                doc(db, 'account_roles', cleanEmail),
                {
                  email: cleanEmail,
                  role: 'ADMIN',
                  churchId: uid,
                  updatedAt: new Date().toISOString(),
                },
                { merge: true }
              );
            } catch {}
          }
          return true;
        }
      } catch (err) {
        console.warn('Error querying churches by uid/adminUids:', err);
      }
    }

    return false;
  };

  try {
    return await executeQuery();
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
  }
): Promise<ChurchMember> {
  try {
    const membersRef = collection(db, 'churches', orgId, 'members');
    const cleanEmail = (memberData.email || '').trim().toLowerCase();

    // 0. Security Guard: Prevent administrators from registering as workforce members
    if (cleanEmail) {
      const orgDoc = await getDoc(doc(db, 'churches', orgId));
      if (orgDoc.exists()) {
        const orgData = orgDoc.data();
        if (
          (orgData.adminEmail && orgData.adminEmail.toLowerCase() === cleanEmail) ||
          (Array.isArray(orgData.adminUids) && orgData.adminUids.includes(cleanEmail))
        ) {
          throw new Error(
            `This account (${cleanEmail}) is registered as an organization administrator on the web portal. Administrator accounts cannot be registered as workforce members on the mobile app. Please sign in with a designated workforce account.`
          );
        }
      }
    }

    // 1. Silent Background Check: Is this physical hardware already bound to someone else?
    if (memberData.boundDeviceId) {
      const qDevice = query(membersRef, where('boundDeviceId', '==', memberData.boundDeviceId));
      const snapDevice = await getDocs(qDevice);
      if (!snapDevice.empty) {
        for (const d of snapDevice.docs) {
          const bound = d.data();
          const boundEmail = (bound.email || '').trim().toLowerCase();
          if (boundEmail && cleanEmail && boundEmail !== cleanEmail) {
            throw new Error(
              `This device has already been bound to ${bound.fullName || 'another worker'} (${bound.email || 'another account'}). Please contact your organization administrator to unbind this device.`
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

        if (existingMember.boundDeviceId && existingMember.boundDeviceId !== memberData.boundDeviceId) {
          throw new Error(
            `Your account is already bound to another registered device. Please use your registered device or contact your administrator to unbind it.`
          );
        }

        const updatesToApply: Record<string, any> = {};
        if (!existingMember.boundDeviceId && memberData.boundDeviceId) {
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
            existingMember.facePhotoURL = memberData.facePhotoURL;
            updatesToApply.facePhotoURL = memberData.facePhotoURL;
          }
        }

        if (Object.keys(updatesToApply).length > 0) {
          await updateDoc(doc(db, 'churches', orgId, 'members', existingMember.id), updatesToApply);
        }

        await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(existingMember));
        return existingMember;
      }
    }

    const memberId = 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    const newMember: ChurchMember = {
      id: memberId,
      fullName: memberData.fullName.trim(),
      phone: memberData.phone.trim(),
      email: memberData.email?.trim().toLowerCase() || undefined,
      photoURL: memberData.photoURL?.trim() || undefined,
      department: memberData.department,
      boundDeviceId: memberData.boundDeviceId,
      registeredAt: new Date().toISOString(),
      ...(memberData.faceEmbedding && memberData.faceEmbedding.length > 0
        ? {
            faceEmbedding: memberData.faceEmbedding,
            isFaceEnrolled: true,
            faceEnrolledAt: new Date().toISOString(),
            facePhotoURL: memberData.facePhotoURL,
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
    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    const updates: Record<string, any> = {
      faceEmbedding,
      isFaceEnrolled: true,
      faceEnrolledAt: new Date().toISOString(),
    };
    if (facePhotoURL) {
      updates.facePhotoURL = facePhotoURL;
    }

    await updateDoc(memberDocRef, updates);

    // Update local cache
    const cached = await getCachedMember();
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
    await updateDoc(memberDocRef, {
      faceEmbedding: [],
      isFaceEnrolled: false,
      faceEnrolledAt: '',
    });

    const cached = await getCachedMember();
    if (cached && cached.id === memberId) {
      cached.faceEmbedding = [];
      cached.isFaceEnrolled = false;
      delete cached.faceEnrolledAt;
      await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(cached));
    }
  } catch (error) {
    console.error('Error clearing member face enrollment:', error);
    throw error;
  }
}

export async function findExistingMember(orgId: string, email?: string, deviceId?: string): Promise<ChurchMember | null> {
  try {
    const membersRef = collection(db, 'churches', orgId, 'members');
    const cleanEmail = (email || '').trim().toLowerCase();

    // Parallelize queries with limit(1) to eliminate sequential network round trips
    const [snapEmail, snapDevice] = await Promise.all([
      cleanEmail
        ? getDocs(query(membersRef, where('email', '==', cleanEmail), limit(1)))
        : Promise.resolve(null),
      deviceId
        ? getDocs(query(membersRef, where('boundDeviceId', '==', deviceId), limit(1)))
        : Promise.resolve(null),
    ]);

    // 1. Primary check: Email match (highest fidelity account identity)
    if (snapEmail && !snapEmail.empty) {
      const d = snapEmail.docs[0];
      const member = { id: d.id, ...d.data() } as ChurchMember;

      // Verify device binding
      if (member.boundDeviceId && deviceId && member.boundDeviceId !== deviceId) {
        throw new Error(
          `Your account is already bound to another registered device. You can only record attendance from your original device. Please contact your administrator to unbind your previous device.`
        );
      }

      // If member exists but device is not yet bound, bind it asynchronously in background without blocking navigation
      if (!member.boundDeviceId && deviceId) {
        member.boundDeviceId = deviceId;
        updateDoc(doc(db, 'churches', orgId, 'members', member.id), {
          boundDeviceId: deviceId,
        }).catch((updateErr) => console.warn('Could not update device binding on existing member:', updateErr));
      }

      AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(member)).catch(() => {});
      return member;
    }

    // 2. Secondary check: Bound device match
    if (snapDevice && !snapDevice.empty) {
      const d = snapDevice.docs[0];
      const bound = d.data();
      const boundEmail = (bound.email || '').trim().toLowerCase();

      // If device is already registered to a DIFFERENT user, reject buddy punching / proxy access
      if (cleanEmail && boundEmail && boundEmail !== cleanEmail) {
        throw new Error(
          `This device is already bound to ${bound.fullName || 'another worker'} (${bound.email || 'another account'}). Please contact your organization administrator to unbind this device.`
        );
      }

      const member = { id: d.id, ...bound } as ChurchMember;
      AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(member)).catch(() => {});
      return member;
    }

    return null;
  } catch (error) {
    // Re-throw security collision errors so they surface to the user
    if (error instanceof Error && error.message.includes('already bound')) {
      throw error;
    }
    console.warn('Could not query existing member:', error);
    return null;
  }
}

/**
 * Recursively cleans an object/array to remove all undefined values.
 * Firestore strictly throws an exception if any field or nested property is undefined.
 */
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

/**
 * Updates an attendance record with worker's sign-out timestamp and display string.
 */
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

/**
 * Flushes all offline-cached punches or sign-outs to the cloud backend.
 * Guarantees that any attendance logged offline is synchronized before the next working day.
 */
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

  // 0. Local cache check
  try {
    const cachedOrg = await getCachedOrganization();
    if (
      cachedOrg &&
      ((cleanEmail && cachedOrg.adminEmail && cachedOrg.adminEmail.toLowerCase() === cleanEmail) ||
        (uid && Array.isArray(cachedOrg.adminUids) && cachedOrg.adminUids.includes(uid)) ||
        (uid && cachedOrg.id === uid))
    ) {
      return cachedOrg;
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
