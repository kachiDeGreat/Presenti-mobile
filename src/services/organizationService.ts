import AsyncStorage from '@react-native-async-storage/async-storage';
import { collection, query, where, getDocs, doc, setDoc, addDoc, updateDoc } from 'firebase/firestore';
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

export async function cacheOrganizationAnchors(org: Organization): Promise<CachedAnchors> {
  const anchors: CachedAnchors = {
    churchId: org.id,
    churchName: org.churchName,
    branchName: org.branchName,
    churchCode: org.churchCode,
    ssidHint: org.beaconConfig.ssidHint,
    targetBssid: org.beaconConfig.targetBssid,
    latitude: org.geoFallback.latitude,
    longitude: org.geoFallback.longitude,
    radiusMeters: org.geoFallback.radiusMeters,
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

export async function registerMember(
  orgId: string,
  memberData: {
    fullName: string;
    phone: string;
    email?: string;
    photoURL?: string;
    department: string;
    boundDeviceId: string;
  }
): Promise<ChurchMember> {
  try {
    const membersRef = collection(db, 'churches', orgId, 'members');
    const cleanEmail = (memberData.email || '').trim().toLowerCase();

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

        if (!existingMember.boundDeviceId && memberData.boundDeviceId) {
          await updateDoc(doc(db, 'churches', orgId, 'members', existingMember.id), {
            boundDeviceId: memberData.boundDeviceId,
          });
          existingMember.boundDeviceId = memberData.boundDeviceId;
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
      email: memberData.email?.trim() || undefined,
      photoURL: memberData.photoURL?.trim() || undefined,
      department: memberData.department,
      boundDeviceId: memberData.boundDeviceId,
      registeredAt: new Date().toISOString(),
    };

    const memberDocRef = doc(db, 'churches', orgId, 'members', memberId);
    await setDoc(memberDocRef, newMember);

    await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(newMember));
    return newMember;
  } catch (error) {
    console.error('Error registering member:', error);
    throw error;
  }
}

export async function findExistingMember(orgId: string, email?: string, deviceId?: string): Promise<ChurchMember | null> {
  try {
    const membersRef = collection(db, 'churches', orgId, 'members');
    const cleanEmail = (email || '').trim().toLowerCase();

    // 1. Silent Background Check: Is this device already bound to ANY member?
    if (deviceId) {
      const qDevice = query(membersRef, where('boundDeviceId', '==', deviceId));
      const snapDevice = await getDocs(qDevice);
      if (!snapDevice.empty) {
        for (const d of snapDevice.docs) {
          const bound = d.data();
          const boundEmail = (bound.email || '').trim().toLowerCase();
          // If device is already registered to a DIFFERENT user, reject buddy punching / proxy access
          if (cleanEmail && boundEmail && boundEmail !== cleanEmail) {
            throw new Error(
              `This device is already bound to ${bound.fullName || 'another worker'} (${bound.email || 'another account'}). Please contact your organization administrator to unbind this device.`
            );
          }
          // If matches user or no email conflict, return this member
          if (!cleanEmail || boundEmail === cleanEmail) {
            const member = { id: d.id, ...bound } as ChurchMember;
            await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(member));
            return member;
          }
        }
      }
    }

    // 2. Query member by email
    if (cleanEmail) {
      const qEmail = query(membersRef, where('email', '==', cleanEmail));
      const snapEmail = await getDocs(qEmail);
      if (!snapEmail.empty) {
        const d = snapEmail.docs[0];
        const member = { id: d.id, ...d.data() } as ChurchMember;

        // If member is already bound to a DIFFERENT physical device
        if (member.boundDeviceId && deviceId && member.boundDeviceId !== deviceId) {
          throw new Error(
            `Your account is already bound to another registered device. You can only record attendance from your original device. Please contact your administrator to unbind your previous device.`
          );
        }

        // If member exists but device is not yet bound, bind it now in the background
        if (!member.boundDeviceId && deviceId) {
          try {
            await updateDoc(doc(db, 'churches', orgId, 'members', member.id), {
              boundDeviceId: deviceId,
            });
            member.boundDeviceId = deviceId;
          } catch (updateErr) {
            console.warn('Could not update device binding on existing member:', updateErr);
          }
        }

        await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(member));
        return member;
      }
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

export async function recordAttendance(orgId: string, input: AttendanceRecordInput): Promise<string> {
  try {
    const attCollection = collection(db, 'churches', orgId, 'attendance');
    const docRef = await addDoc(attCollection, input);
    return docRef.id;
  } catch (error) {
    console.error('Error logging attendance record:', error);
    throw error;
  }
}
