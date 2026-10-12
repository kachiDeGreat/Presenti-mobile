import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as FirebaseAuth from 'firebase/auth';
import { auth, googleProvider } from '../config/firebase';
import { getDeviceFingerprint } from '../services/deviceService';
import {
  fetchOrganizationByCode,
  cacheOrganizationAnchors,
  getCachedAnchors,
  getCachedOrganization,
  getCachedMember,
  registerMember,
  findExistingMember,
} from '../services/organizationService';
import type { Organization, CachedAnchors, ChurchMember, MobileUser } from '../types';

interface AuthContextType {
  user: MobileUser | null;
  organization: Organization | null;
  member: ChurchMember | null;
  cachedAnchors: CachedAnchors | null;
  deviceId: string;
  isLoading: boolean;
  knownAccounts: MobileUser[];
  signInWithGoogle: (customUser?: Partial<MobileUser>) => Promise<void>;
  signInWithGoogleCredential: (idToken: string) => Promise<void>;
  addOrSelectGoogleAccount: (account: MobileUser) => Promise<void>;
  pairOrganization: (code: string) => Promise<Organization>;
  completeRegistration: (fullName: string, phone: string, department: string) => Promise<ChurchMember>;
  signOut: () => Promise<void>;
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
        }

        if (storedMember) {
          setMember(storedMember);
        }

        if (storedAnchors) {
          setCachedAnchors(storedAnchors);
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

  const handleUserAuthenticated = useCallback(
    async (authUser: MobileUser) => {
      // 1. Persist user session
      await AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(authUser));
      setUser(authUser);

      // 2. Persist to known accounts list on this device
      setKnownAccounts((prev) => {
        const filtered = prev.filter((a) => a.email.toLowerCase() !== authUser.email.toLowerCase());
        const updated = [authUser, ...filtered];
        AsyncStorage.setItem(STORAGE_KEY_KNOWN_ACCOUNTS, JSON.stringify(updated)).catch(() => {});
        return updated;
      });

      // 3. If an organization is already active, perform background device binding resolution
      const activeOrg = organization || (await getCachedOrganization());
      if (activeOrg && deviceId) {
        try {
          const existing = await findExistingMember(activeOrg.id, authUser.email, deviceId);
          if (existing) {
            setMember(existing);
          } else {
            setMember(null);
          }
        } catch (error) {
          // If device collision or bound to another person, clear user session so unauthorized user is blocked
          await AsyncStorage.removeItem(STORAGE_KEY_USER);
          setUser(null);
          throw error;
        }
      }
    },
    [organization, deviceId]
  );

  const signInWithGoogle = async (customUser?: Partial<MobileUser>) => {
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
        await handleUserAuthenticated(authUser);
        return;
      }

      const authUser: MobileUser = {
        uid: customUser?.uid || 'google_uid_' + Date.now().toString(36),
        email: customUser?.email || 'staff.member@gmail.com',
        displayName: customUser?.displayName || 'Workforce Member',
        photoURL: customUser?.photoURL,
      };

      await handleUserAuthenticated(authUser);
    } catch (error) {
      console.error('Google Sign-In failed:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const signInWithGoogleCredential = async (idToken: string) => {
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
      await handleUserAuthenticated(authUser);
    } catch (error) {
      console.error('Firebase Google Credential Sign-In failed:', error);
      throw error;
    } finally {
      setIsLoading(false);
    }
  };

  const addOrSelectGoogleAccount = async (selectedAccount: MobileUser) => {
    setIsLoading(true);
    try {
      await handleUserAuthenticated(selectedAccount);
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

