import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
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
  knownAccounts: MobileUser[];
  signInWithGoogle: (customUser?: Partial<MobileUser>) => Promise<AuthResult>;
  signInWithGoogleCredential: (idToken: string) => Promise<AuthResult>;
  addOrSelectGoogleAccount: (account: MobileUser) => Promise<AuthResult>;
  pairOrganization: (code: string) => Promise<Organization>;
  completeRegistration: (fullName: string, phone: string, department: string) => Promise<ChurchMember>;
  signOut: () => Promise<void>;
  refreshOrganization: () => Promise<Organization | null>;
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
          const isAdmin = await checkIfUserIsAdmin(loadedUser.email, loadedUser.uid);
          if (isAdmin) {
            await AsyncStorage.multiRemove([STORAGE_KEY_USER, STORAGE_KEY_MEMBER]);
            loadedUser = null;
            setUser(null);
            setMember(null);
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
      // Security Check: Verify that this account is not an organization administrator on the web portal
      const cleanEmail = (authUser.email || '').trim().toLowerCase();
      const isAdmin = await checkIfUserIsAdmin(cleanEmail, authUser.uid);
      if (isAdmin) {
        if (Platform.OS === 'web' && auth.currentUser) {
          await FirebaseAuth.signOut(auth).catch(() => {});
        }
        await AsyncStorage.multiRemove([STORAGE_KEY_USER, STORAGE_KEY_MEMBER]);
        setUser(null);
        setMember(null);
        throw new Error(
          `This account (${cleanEmail}) is registered as an organization administrator on the web portal. Administrator accounts cannot be used as workforce members on the mobile app. Please sign in with a designated workforce account.`
        );
      }

      // 1. Persist user session
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

      // 4. Resolve active organization (from state, local cache, or Firestore)
      let activeOrg = organization || (await getCachedOrganization());
      let existingMember: ChurchMember | null = await getCachedMember();

      // If cached member does not match the newly logged in user, don't use stale member
      if (
        existingMember &&
        existingMember.email &&
        authUser.email &&
        existingMember.email.toLowerCase() !== authUser.email.toLowerCase()
      ) {
        existingMember = null;
      }

      // If activeOrg is missing, search across churches in Firestore by member email (capped at 3s)
      if (!activeOrg && authUser.email) {
        try {
          const membersGroup = collectionGroup(db, 'members');
          const cleanEmail = authUser.email.trim().toLowerCase();
          const q = query(membersGroup, where('email', '==', cleanEmail), limit(1));
          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000));
          const snap = await Promise.race([getDocs(q), timeoutPromise]);

          if (snap && !snap.empty) {
            const memberDoc = snap.docs[0];
            const churchDocRef = memberDoc.ref.parent.parent;
            if (churchDocRef) {
              const churchSnap = await getDoc(churchDocRef);
              if (churchSnap.exists()) {
                const churchData = { id: churchSnap.id, ...churchSnap.data() } as any;
                activeOrg = {
                  id: churchSnap.id,
                  churchName: churchData.churchName || 'Church',
                  branchName: churchData.branchName || 'Main Branch',
                  churchCode: churchData.churchCode || '',
                  departments: churchData.departments || [],
                  beaconConfig: churchData.beaconConfig,
                  geoFallback: churchData.geoFallback,
                  policySettings: churchData.policySettings,
                };
                cacheOrganizationAnchors(activeOrg).catch(() => {});
              }
            }
          }
        } catch (cgErr) {
          console.warn('Organization search by email skipped:', cgErr);
        }
      }

      // 5. If we have activeOrg, query existing member in this organization
      if (activeOrg) {
        setOrganization(activeOrg);
        try {
          const found = await findExistingMember(activeOrg.id, authUser.email, activeDeviceId);
          if (found) {
            existingMember = found;
          }
        } catch (error) {
          console.warn('findExistingMember check error:', error);
          await AsyncStorage.removeItem(STORAGE_KEY_USER);
          setUser(null);
          throw error;
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
    setIsLoading(true);
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
    } finally {
      setIsLoading(false);
    }
  };

  const signInWithGoogleCredential = async (idToken: string): Promise<AuthResult> => {
    setIsLoading(true);
    try {
      const credential = FirebaseAuth.GoogleAuthProvider.credential(idToken);
      const cred = await FirebaseAuth.signInWithCredential(auth, credential);
      const authUser: MobileUser = {
        uid: cred.user.uid,
        email: cred.user.email || '',
        displayName: cred.user.displayName || cred.user.email?.split('@')[0] || 'Workforce Member',
        photoURL: cred.user.photoURL || undefined,
      };
      return await handleUserAuthenticated(authUser);
    } catch (error) {
      console.error('Firebase Google Credential Sign-In failed:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const addOrSelectGoogleAccount = async (selectedAccount: MobileUser): Promise<AuthResult> => {
    setIsLoading(true);
    try {
      return await handleUserAuthenticated(selectedAccount);
    } finally {
      setIsLoading(false);
    }
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
    department: string
  ): Promise<ChurchMember> => {
    if (!organization) {
      throw new Error('Please pair an organization first.');
    }

    const cleanEmail = (user?.email || '').trim().toLowerCase();
    const isAdmin = await checkIfUserIsAdmin(cleanEmail, user?.uid);
    if (isAdmin) {
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
    });

    setMember(newMember);
    return newMember;
  };

  const signOut = async () => {
    try {
      if (Platform.OS === 'web' && auth.currentUser) {
        await FirebaseAuth.signOut(auth);
      }
      await AsyncStorage.multiRemove([STORAGE_KEY_USER, STORAGE_KEY_MEMBER]);
      setUser(null);
      setMember(null);
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        organization,
        member,
        cachedAnchors,
        deviceId,
        isLoading,
        knownAccounts,
        signInWithGoogle,
        signInWithGoogleCredential,
        addOrSelectGoogleAccount,
        pairOrganization,
        completeRegistration,
        signOut,
        refreshOrganization,
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

