import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import * as FirebaseAuth from 'firebase/auth';
import {
  collectionGroup,
  query,
  where,
  getDocs,
  getDoc,
  limit,
} from 'firebase/firestore';
import { auth, db, googleProvider } from '../config/firebase';
import { getDeviceFingerprint } from '../services/deviceService';
import {
  fetchOrganizationByCode,
  fetchFreshOrganizationById,
  subscribeToOrganization,
  cacheOrganizationAnchors,
  getCachedAnchors,
  getCachedOrganization,
  getCachedMember,
  registerMember,
  findExistingMember,
  checkIfUserIsAdmin,
  getAdminOrganization,
  updateOrganizationAnchors as updateOrganizationAnchorsService,
  updateMemberFaceEnrollment,
} from '../services/organizationService';
import type { Organization, CachedAnchors, ChurchMember, MobileUser } from '../types';

export interface AuthResult {
  user: MobileUser;
  organization: Organization | null;
  member: ChurchMember | null;
}

interface AuthContextType {
  user: MobileUser | null;
  organization: Organization | null;
  member: ChurchMember | null;
  cachedAnchors: CachedAnchors | null;
  deviceId: string;
  isLoading: boolean;
  isAdmin: boolean;
  knownAccounts: MobileUser[];
  signInWithGoogle: (customUser?: Partial<MobileUser>) => Promise<AuthResult>;
  signInWithGoogleCredential: (idToken: string, profileHint?: Partial<MobileUser>) => Promise<AuthResult>;
  addOrSelectGoogleAccount: (account: MobileUser) => Promise<AuthResult>;
  pairOrganization: (code: string) => Promise<Organization>;
  completeRegistration: (
    fullName: string,
    phone: string,
    department: string,
    faceEmbedding?: number[],
    facePhotoURL?: string
  ) => Promise<ChurchMember>;
  enrollFace: (faceEmbedding: number[], facePhotoURL?: string) => Promise<void>;
  checkAdminStatus: (email?: string, uid?: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  refreshOrganization: () => Promise<Organization | null>;
  updateAnchors: (anchors: {
    ssidHint: string;
    targetBssid: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
    verificationMode?: 'HYBRID' | 'GEOFENCE_ONLY';
  }) => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const STORAGE_KEY_USER = '@sanctuary_user';
const STORAGE_KEY_ORG = '@sanctuary_active_org';
const STORAGE_KEY_MEMBER = '@sanctuary_member_profile';
const STORAGE_KEY_ANCHORS = '@sanctuary_cached_anchors';
const STORAGE_KEY_KNOWN_ACCOUNTS = '@sanctuary_known_google_accounts';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<MobileUser | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [member, setMember] = useState<ChurchMember | null>(null);
  const [cachedAnchors, setCachedAnchors] = useState<CachedAnchors | null>(null);
  const [deviceId, setDeviceId] = useState<string>('');
  const [knownAccounts, setKnownAccounts] = useState<MobileUser[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  // Initialize session on mount
  useEffect(() => {
    async function initSession() {
      try {
        const id = await getDeviceFingerprint();
        setDeviceId(id);

        const [storedUserRaw, storedOrg, storedMember, storedAnchors, storedAccountsRaw] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEY_USER),
          getCachedOrganization(),
          getCachedMember(),
          getCachedAnchors(),
          AsyncStorage.getItem(STORAGE_KEY_KNOWN_ACCOUNTS),
        ]);

        let loadedUser: MobileUser | null = null;
        if (storedUserRaw) {
          try {
            loadedUser = JSON.parse(storedUserRaw);
            setUser(loadedUser);
          } catch {
            // invalid json
          }
        }

        let loadedOrg = storedOrg;
        if (loadedOrg) {
          setOrganization(loadedOrg);
          fetchFreshOrganizationById(loadedOrg.id)
            .then((fresh) => {
              if (fresh) {
                setOrganization(fresh);
              } else {
                setOrganization(null);
                setCachedAnchors(null);
                AsyncStorage.multiRemove([STORAGE_KEY_ORG, STORAGE_KEY_ANCHORS]).catch(() => {});
              }
            })
            .catch(() => {});
        }

        if (storedMember) {
          setMember(storedMember);
        }

        if (storedAnchors) {
          setCachedAnchors(storedAnchors);
        } else if (loadedOrg) {
          const freshAnchors: CachedAnchors = {
            churchId: loadedOrg.id,
            churchName: loadedOrg.churchName,
            branchName: loadedOrg.branchName,
            churchCode: loadedOrg.churchCode,
            ssidHint: loadedOrg.beaconConfig?.ssidHint || '',
            targetBssid: loadedOrg.beaconConfig?.targetBssid || '',
            latitude: loadedOrg.geoFallback?.latitude ?? 0,
            longitude: loadedOrg.geoFallback?.longitude ?? 0,
            radiusMeters: loadedOrg.geoFallback?.radiusMeters ?? 10,
            cachedAt: new Date().toISOString(),
          };
          setCachedAnchors(freshAnchors);
          AsyncStorage.setItem(STORAGE_KEY_ANCHORS, JSON.stringify(freshAnchors)).catch(() => {});
        }

        let parsedAccounts: MobileUser[] = [];
        if (storedAccountsRaw) {
          try {
            parsedAccounts = JSON.parse(storedAccountsRaw);
          } catch {
            // invalid json
          }
        }

        if (loadedUser && !parsedAccounts.some((a) => a.email.toLowerCase() === loadedUser!.email.toLowerCase())) {
          parsedAccounts.unshift(loadedUser);
          await AsyncStorage.setItem(STORAGE_KEY_KNOWN_ACCOUNTS, JSON.stringify(parsedAccounts));
        }
        setKnownAccounts(parsedAccounts);

        if (loadedUser) {
          const cleanEmail = (loadedUser.email || '').trim().toLowerCase();
          const isAdminUser = loadedUser.isAdmin === true || (await checkIfUserIsAdmin(cleanEmail, loadedUser.uid));
          if (isAdminUser) {
            const adminUser: MobileUser = { ...loadedUser, isAdmin: true };
            setUser(adminUser);
            const adminOrg = await getAdminOrganization(cleanEmail, loadedUser.uid);
            if (adminOrg) {
              setOrganization(adminOrg);
              await cacheOrganizationAnchors(adminOrg);
            }
          } else {
            setUser({ ...loadedUser, isAdmin: false });
          }
        }

        // Silent background check if user and org exist: ensure device binding is still valid
        if (loadedUser && loadedOrg && id) {
          findExistingMember(loadedOrg.id, loadedUser.email, id)
            .then((verified) => {
              if (verified) {
                setMember(verified);
              }
            })
            .catch((err) => {
              console.warn('Background device binding verification:', err?.message || err);
            });
        }
      } catch (err) {
        console.warn('Failed to restore mobile session:', err);
      } finally {
        setIsLoading(false);
      }
    }

    initSession();
  }, []);

  // Real-time synchronization: subscribe to organization policy, beacons, and geofence updates
  useEffect(() => {
    if (!organization?.id) return;

    const unsubscribe = subscribeToOrganization(
      organization.id,
      (freshOrg) => {
        setOrganization(freshOrg);
        const freshAnchors: CachedAnchors = {
          churchId: freshOrg.id,
          churchName: freshOrg.churchName,
          branchName: freshOrg.branchName,
          churchCode: freshOrg.churchCode,
          ssidHint: freshOrg.beaconConfig?.ssidHint || '',
          targetBssid: freshOrg.beaconConfig?.targetBssid || '',
          latitude: freshOrg.geoFallback?.latitude ?? 0,
          longitude: freshOrg.geoFallback?.longitude ?? 0,
          radiusMeters: freshOrg.geoFallback?.radiusMeters ?? 10,
          cachedAt: new Date().toISOString(),
        };
        setCachedAnchors(freshAnchors);
      },
      (err) => {
        console.warn('Real-time organization sync error:', err);
      }
    );

    return () => unsubscribe();
  }, [organization?.id]);

  const refreshOrganization = useCallback(async (): Promise<Organization | null> => {
    if (!organization?.id) return null;
    try {
      const fresh = await fetchFreshOrganizationById(organization.id);
      if (fresh) {
        setOrganization(fresh);
        const freshAnchors: CachedAnchors = {
          churchId: fresh.id,
          churchName: fresh.churchName,
          branchName: fresh.branchName,
          churchCode: fresh.churchCode,
          ssidHint: fresh.beaconConfig?.ssidHint || '',
          targetBssid: fresh.beaconConfig?.targetBssid || '',
          latitude: fresh.geoFallback?.latitude ?? 0,
          longitude: fresh.geoFallback?.longitude ?? 0,
          radiusMeters: fresh.geoFallback?.radiusMeters ?? 10,
          cachedAt: new Date().toISOString(),
        };
        setCachedAnchors(freshAnchors);
      }
      return fresh;
    } catch (err) {
      console.warn('Manual refreshOrganization failed:', err);
      return null;
    }
  }, [organization?.id]);

  const handleUserAuthenticated = useCallback(
    async (authUser: MobileUser): Promise<AuthResult> => {
      const cleanEmail = (authUser.email || '').trim().toLowerCase();
      const uid = authUser.uid;

      // 0. Check role: If user is an Administrator, grant access to the Mobile Admin Command Center
      const isAdmin = authUser.isAdmin === true || (await checkIfUserIsAdmin(cleanEmail, uid));
      if (isAdmin) {
        const adminUser: MobileUser = { ...authUser, isAdmin: true };
        await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(adminUser));
        setUser(adminUser);

        setKnownAccounts((prev) => {
          const filtered = prev.filter((a) => a.email.toLowerCase() !== adminUser.email.toLowerCase());
          const updated = [adminUser, ...filtered];
          AsyncStorage.setItem(STORAGE_KEY_KNOWN_ACCOUNTS, JSON.stringify(updated)).catch(() => {});
          return updated;
        });

        const adminOrg = await getAdminOrganization(cleanEmail, uid);
        if (adminOrg) {
          setOrganization(adminOrg);
          await cacheOrganizationAnchors(adminOrg);
        }
        return { user: adminUser, organization: adminOrg, member: null };
      }

      // 1. Instant user session persistence
      AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(authUser)).catch(() => {});
      setUser(authUser);

      // 2. Persist to known accounts list on this device
      setKnownAccounts((prev) => {
        const filtered = prev.filter((a) => a.email.toLowerCase() !== authUser.email.toLowerCase());
        const updated = [authUser, ...filtered];
        AsyncStorage.setItem(STORAGE_KEY_KNOWN_ACCOUNTS, JSON.stringify(updated)).catch(() => {});
        return updated;
      });

      // 3. Resolve active device ID
      const activeDeviceId = deviceId || (await getDeviceFingerprint());
      if (activeDeviceId && !deviceId) {
        setDeviceId(activeDeviceId);
      }

      // 4. Resolve active organization (from state or device local cache)
      let activeOrg = organization || (await getCachedOrganization());
      let existingMember: ChurchMember | null = await getCachedMember();

      // If cached member does not match the newly logged in user, clear stale member
      if (
        existingMember &&
        existingMember.email &&
        authUser.email &&
        existingMember.email.toLowerCase() !== authUser.email.toLowerCase()
      ) {
        existingMember = null;
      }

      // 5. If organization is already paired on this device, check member enrollment
      if (activeOrg) {
        setOrganization(activeOrg);
        try {
          const found = await findExistingMember(activeOrg.id, authUser.email, activeDeviceId);
          if (found) {
            existingMember = found;
          }
        } catch (error) {
          console.warn('findExistingMember check error:', error);
        }
      }

      if (existingMember) {
        setMember(existingMember);
        await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(existingMember));
      } else {
        setMember(null);
        await AsyncStorage.removeItem(STORAGE_KEY_MEMBER);
      }

      return {
        user: authUser,
        organization: activeOrg,
        member: existingMember,
      };
    },
    [organization, deviceId]
  );

  const signInWithGoogle = async (customUser?: Partial<MobileUser>): Promise<AuthResult> => {
    try {
      if (Platform.OS === 'web' && !customUser) {
        const cred = await FirebaseAuth.signInWithPopup(auth, googleProvider);
        const authUser: MobileUser = {
          uid: cred.user.uid,
          email: cred.user.email || 'user@gmail.com',
          displayName: cred.user.displayName || cred.user.email?.split('@')[0] || 'Workforce Member',
          photoURL: cred.user.photoURL || undefined,
        };
        return await handleUserAuthenticated(authUser);
      }

      const authUser: MobileUser = {
        uid: customUser?.uid || 'google_uid_' + Date.now().toString(36),
        email: customUser?.email || 'staff.member@gmail.com',
        displayName: customUser?.displayName || 'Workforce Member',
        photoURL: customUser?.photoURL,
      };

      return await handleUserAuthenticated(authUser);
    } catch (error) {
      console.error('Google Sign-In failed:', error);
      throw error;
    }
  };

  const signInWithGoogleCredential = async (
    idToken: string,
    profileHint?: Partial<MobileUser>
  ): Promise<AuthResult> => {
    try {
      const credential = FirebaseAuth.GoogleAuthProvider.credential(idToken);
      const cred = await FirebaseAuth.signInWithCredential(auth, credential);
      const effectiveEmail = (cred.user.email || profileHint?.email || '').trim();
      const effectiveName =
        cred.user.displayName ||
        profileHint?.displayName ||
        effectiveEmail.split('@')[0] ||
        'Workforce Member';
      const effectivePhoto = cred.user.photoURL || profileHint?.photoURL || undefined;

      const authUser: MobileUser = {
        uid: cred.user.uid,
        email: effectiveEmail,
        displayName: effectiveName,
        photoURL: effectivePhoto,
      };
      return await handleUserAuthenticated(authUser);
    } catch (error) {
      console.error('Firebase Google Credential Sign-In failed:', error);
      throw error;
    }
  };

  const addOrSelectGoogleAccount = async (selectedAccount: MobileUser): Promise<AuthResult> => {
    return await handleUserAuthenticated(selectedAccount);
  };

  const pairOrganization = async (code: string): Promise<Organization> => {
    const org = await fetchOrganizationByCode(code);
    if (!org) {
      throw new Error('No organization found matching code "' + code.toUpperCase() + '". Please verify with your administrator.');
    }

    const anchors = await cacheOrganizationAnchors(org);
    setOrganization(org);
    setCachedAnchors(anchors);

    if (user && deviceId) {
      const existing = await findExistingMember(org.id, user.email, deviceId);
      if (existing) {
        setMember(existing);
      }
    }

    return org;
  };

  const completeRegistration = async (
    fullName: string,
    phone: string,
    department: string,
    faceEmbedding?: number[],
    facePhotoURL?: string
  ): Promise<ChurchMember> => {
    if (!organization) {
      throw new Error('Please pair an organization first.');
    }

    const cleanEmail = (user?.email || '').trim().toLowerCase();
    const isAdminAccount = user?.isAdmin || (await checkIfUserIsAdmin(cleanEmail, user?.uid));
    if (
      isAdminAccount ||
      (organization.adminEmail && cleanEmail && organization.adminEmail.toLowerCase() === cleanEmail) ||
      (organization.adminUids && user?.uid && organization.adminUids.includes(user.uid)) ||
      (organization.id && user?.uid && organization.id === user.uid)
    ) {
      throw new Error(
        `This account (${cleanEmail}) is registered as an organization administrator on the web portal and cannot be registered as a workforce member.`
      );
    }

    const newMember = await registerMember(organization.id, {
      fullName,
      phone,
      email: user?.email,
      photoURL: user?.photoURL,
      department,
      boundDeviceId: deviceId, // Silently bound in background
      faceEmbedding,
      facePhotoURL,
      isFaceEnrolled: Boolean(faceEmbedding && faceEmbedding.length > 0),
    });

    setMember(newMember);
    return newMember;
  };

  const enrollFace = async (faceEmbedding: number[], facePhotoURL?: string): Promise<void> => {
    if (!organization?.id || !member?.id) {
      throw new Error('No active organization or member profile found.');
    }
    await updateMemberFaceEnrollment(organization.id, member.id, faceEmbedding, facePhotoURL);
    const updatedMember: ChurchMember = {
      ...member,
      faceEmbedding,
      isFaceEnrolled: true,
      faceEnrolledAt: new Date().toISOString(),
      ...(facePhotoURL ? { facePhotoURL } : {}),
    };
    setMember(updatedMember);
    await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(updatedMember));
  };

  const checkAdminStatus = useCallback(
    async (emailOverride?: string, uidOverride?: string): Promise<boolean> => {
      const targetEmail = (emailOverride || user?.email || '').trim().toLowerCase();
      const targetUid = uidOverride || user?.uid;
      if (!targetEmail && !targetUid) return false;

      const isAdminUser = await checkIfUserIsAdmin(targetEmail, targetUid);
      if (isAdminUser && user) {
        const updatedUser: MobileUser = { ...user, isAdmin: true };
        setUser(updatedUser);
        await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(updatedUser)).catch(() => {});
        if (!organization) {
          const adminOrg = await getAdminOrganization(targetEmail, targetUid);
          if (adminOrg) {
            setOrganization(adminOrg);
            await AsyncStorage.setItem(STORAGE_KEY_ORG, JSON.stringify(adminOrg)).catch(() => {});
          }
        }
      }
      return isAdminUser;
    },
    [user, organization]
  );

  const signOut = async () => {
    try {
      if (auth.currentUser) {
        await FirebaseAuth.signOut(auth);
      }
      if (Platform.OS !== 'web') {
        try {
          await GoogleSignin.signOut();
        } catch {}
        try {
          await GoogleSignin.revokeAccess();
        } catch {}
      }
      await AsyncStorage.multiRemove([
        STORAGE_KEY_USER,
        STORAGE_KEY_MEMBER,
        STORAGE_KEY_KNOWN_ACCOUNTS,
      ]);
      setUser(null);
      setMember(null);
      setKnownAccounts([]);
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  const updateAnchors = useCallback(
    async (anchors: {
      ssidHint: string;
      targetBssid: string;
      latitude: number;
      longitude: number;
      radiusMeters: number;
      verificationMode?: 'HYBRID' | 'GEOFENCE_ONLY';
    }) => {
      const targetOrgId = organization?.id;
      if (!targetOrgId) {
        throw new Error('No active organization found to calibrate.');
      }
      const mode = anchors.verificationMode || (anchors.targetBssid.trim() ? 'HYBRID' : 'GEOFENCE_ONLY');
      await updateOrganizationAnchorsService(targetOrgId, anchors);
      const updatedOrg: Organization = {
        ...organization,
        beaconConfig: {
          ssidHint: anchors.ssidHint,
          targetBssid: anchors.targetBssid,
          verificationMode: mode,
        },
        geoFallback: {
          latitude: anchors.latitude,
          longitude: anchors.longitude,
          radiusMeters: anchors.radiusMeters,
          isConfigured: true,
        },
      };
      setOrganization(updatedOrg);
      await AsyncStorage.setItem(STORAGE_KEY_ORG, JSON.stringify(updatedOrg)).catch(() => {});
      const updatedCachedAnchors: CachedAnchors = {
        churchId: targetOrgId,
        churchName: updatedOrg.churchName,
        branchName: updatedOrg.branchName,
        churchCode: updatedOrg.churchCode,
        ssidHint: anchors.ssidHint,
        targetBssid: anchors.targetBssid,
        latitude: anchors.latitude,
        longitude: anchors.longitude,
        radiusMeters: anchors.radiusMeters,
        verificationMode: mode,
        cachedAt: new Date().toISOString(),
      };
      setCachedAnchors(updatedCachedAnchors);
      await AsyncStorage.setItem(STORAGE_KEY_ANCHORS, JSON.stringify(updatedCachedAnchors)).catch(() => {});
    },
    [organization]
  );

  return (
    <AuthContext.Provider
      value={{
        user,
        organization,
        member,
        cachedAnchors,
        deviceId,
        isLoading,
        isAdmin: Boolean(user?.isAdmin),
        knownAccounts,
        signInWithGoogle,
        signInWithGoogleCredential,
        addOrSelectGoogleAccount,
        pairOrganization,
        completeRegistration,
        enrollFace,
        checkAdminStatus,
        signOut,
        refreshOrganization,
        updateAnchors,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

