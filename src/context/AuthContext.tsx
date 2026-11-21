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
  setDoc,
  doc,
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
  hydrateMemberWithLocalFaceVault,
  saveFaceToLocalVault,
  enforceDeviceWorkerLock,
  saveDeviceWorkerLock,
  promoteEmailToAdminIfNotActiveWorker,
  createAdminOrganization,
  updateOrganizationSettings,
  deleteAdminOrganizationWorkspace,
} from '../services/organizationService';
import {
  sendMobileSignupOtp,
  sendMobilePasswordResetOtp,
  verifyMobileOtp,
  sendMobileWelcomeEmail,
  type SendMobileOtpResult,
} from '../services/mobileEmailService';
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
  authStepLabel: string | null;
  isAdmin: boolean;
  knownAccounts: MobileUser[];
  loginWithEmailPassword: (email: string, password: string) => Promise<AuthResult>;
  registerWithEmailPassword: (
    email: string,
    password: string,
    displayName: string,
    role: 'ADMIN' | 'WORKER'
  ) => Promise<AuthResult>;
  sendMobileOtp: (
    email: string,
    purpose: 'SIGNUP' | 'RESET_PASSWORD',
    intendedRole?: 'ADMIN' | 'WORKER'
  ) => Promise<SendMobileOtpResult>;
  verifyMobileOtpCode: (email: string, code: string, purpose: 'SIGNUP' | 'RESET_PASSWORD') => Promise<boolean>;
  resetPasswordWithOtp: (email: string, code: string, newPassword: string) => Promise<void>;
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
  createAdminOrg: (params: {
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
  }) => Promise<Organization>;
  updateOrgSettings: (updates: {
    churchName: string;
    branchName: string;
    departments: string[];
    policySettings: import('../types').PolicySettings;
  }) => Promise<void>;
  deleteAdminOrg: () => Promise<void>;
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
  const [authStepLabel, setAuthStepLabel] = useState<string | null>(null);

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
          const fresh = await fetchFreshOrganizationById(loadedOrg.id).catch(() => null);
          if (fresh) {
            setOrganization(fresh);
            loadedOrg = fresh;
          } else {
            // Organization was deleted or not found in Firestore
            loadedOrg = null;
            setOrganization(null);
            setMember(null);
            setCachedAnchors(null);
            await AsyncStorage.multiRemove([
              STORAGE_KEY_ORG,
              STORAGE_KEY_ANCHORS,
              STORAGE_KEY_MEMBER,
            ]).catch(() => {});
          }
        }

        if (storedMember && loadedOrg) {
          const hydrated = await hydrateMemberWithLocalFaceVault(storedMember, loadedOrg.id);
          setMember(hydrated);
        } else if (storedMember) {
          const hydrated = await hydrateMemberWithLocalFaceVault(storedMember);
          setMember(hydrated);
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

      try {
        setAuthStepLabel('Detecting account role...');
        // 0. Check Admin status + resolve deviceId in parallel (1 round-trip instead of sequential)
        const [isAdmin, activeDeviceId] = await Promise.all([
          authUser.isAdmin === true
            ? Promise.resolve(true)
            : checkIfUserIsAdmin(cleanEmail, uid),
          deviceId ? Promise.resolve(deviceId) : getDeviceFingerprint(),
        ]);

        if (activeDeviceId && !deviceId) {
          setDeviceId(activeDeviceId);
        }

        if (isAdmin) {
          setAuthStepLabel('Loading admin workspace...');
          const adminUser: MobileUser = { ...authUser, isAdmin: true };
          const adminOrg = await getAdminOrganization(cleanEmail, uid);

          AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(adminUser)).catch(() => {});
          if (adminOrg) {
            cacheOrganizationAnchors(adminOrg).catch(() => {});
            setOrganization(adminOrg);
          }
          setMember(null);
          setUser(adminUser);

          setKnownAccounts((prev) => {
            const filtered = prev.filter((a) => a.email.toLowerCase() !== adminUser.email.toLowerCase());
            const updated = [adminUser, ...filtered];
            AsyncStorage.setItem(STORAGE_KEY_KNOWN_ACCOUNTS, JSON.stringify(updated)).catch(() => {});
            return updated;
          });

          return { user: adminUser, organization: adminOrg, member: null };
        }

        setAuthStepLabel('Checking device binding...');
        // 1. Run 1-Worker-1-Phone lock + local cache reads + account_roles lookup in parallel!
      let activeOrg = organization;
      let existingMember: ChurchMember | null = null;
      let roleChurchId: string | null = null;

      try {
        const [, cachedOrg, cachedMem, roleSnap] = await Promise.all([
          enforceDeviceWorkerLock({
            deviceId: activeDeviceId,
            candidateEmail: cleanEmail,
          }),
          activeOrg ? Promise.resolve(activeOrg) : getCachedOrganization(),
          getCachedMember(),
          cleanEmail && db
            ? getDoc(doc(db, 'account_roles', cleanEmail)).catch(() => null)
            : Promise.resolve(null),
        ]);

        activeOrg = cachedOrg;
        existingMember = cachedMem;
        if (roleSnap?.exists() && roleSnap.data()?.role === 'WORKER') {
          roleChurchId = roleSnap.data()?.churchId || null;
        }
      } catch (lockErr) {
        if (auth.currentUser) {
          await FirebaseAuth.signOut(auth).catch(() => {});
        }
        await AsyncStorage.removeItem(STORAGE_KEY_USER).catch(() => {});
        setUser(null);
        throw lockErr;
      }

      // 2. Persist to known accounts list on this device (commit setUser together with org/member at the end)
      AsyncStorage.setItem(STORAGE_KEY_USER, JSON.stringify(authUser)).catch(() => {});
      setKnownAccounts((prev) => {
        const filtered = prev.filter((a) => a.email.toLowerCase() !== authUser.email.toLowerCase());
        const updated = [authUser, ...filtered];
        AsyncStorage.setItem(STORAGE_KEY_KNOWN_ACCOUNTS, JSON.stringify(updated)).catch(() => {});
        return updated;
      });

      // If cached member does not match the newly logged in user, clear stale member
      if (
        existingMember &&
        existingMember.email &&
        authUser.email &&
        existingMember.email.toLowerCase() !== authUser.email.toLowerCase()
      ) {
        existingMember = null;
      }

      // 3. Resolve organization & member in parallel when orgId is known from cache or account_roles
      const targetOrgId = activeOrg?.id || roleChurchId;
      if (targetOrgId) {
        try {
          const [freshOrg, found] = await Promise.all([
            fetchFreshOrganizationById(targetOrgId).catch(() => null),
            findExistingMember(targetOrgId, authUser.email, activeDeviceId),
          ]);

          if (!freshOrg || !found) {
            existingMember = null;
            activeOrg = null;
            setOrganization(null);
            setCachedAnchors(null);
            AsyncStorage.multiRemove([STORAGE_KEY_ORG, STORAGE_KEY_ANCHORS, STORAGE_KEY_MEMBER]).catch(() => {});
          } else {
            activeOrg = freshOrg;
            existingMember = found;
            setOrganization(activeOrg);
          }
        } catch (error) {
          if (
            error instanceof Error &&
            (error.message.includes('already bound') ||
              error.message.includes('still registered') ||
              error.message.includes('Only one worker'))
          ) {
            if (auth.currentUser) {
              await FirebaseAuth.signOut(auth).catch(() => {});
            }
            await AsyncStorage.removeItem(STORAGE_KEY_USER).catch(() => {});
            setUser(null);
            throw error;
          }
          console.warn('findExistingMember check error:', error);
        }
      }

      // 6c. Fallback collectionGroup lookup across organizations
      if (!activeOrg && cleanEmail && db) {
        try {
          const membersGroupQuery = query(
            collectionGroup(db, 'members'),
            where('email', '==', cleanEmail),
            limit(1)
          );
          const groupSnap = await getDocs(membersGroupQuery);
          if (!groupSnap.empty) {
            const memberDoc = groupSnap.docs[0];
            const churchDocRef = memberDoc.ref.parent.parent;
            if (churchDocRef) {
              const freshOrg = await fetchFreshOrganizationById(churchDocRef.id);
              if (freshOrg) {
                const mData = memberDoc.data();
                const boundDev = (mData.boundDeviceId || '').trim();
                if (
                  boundDev &&
                  boundDev !== 'UNBOUND' &&
                  activeDeviceId &&
                  boundDev !== activeDeviceId
                ) {
                  if (auth.currentUser) {
                    await FirebaseAuth.signOut(auth).catch(() => {});
                  }
                  await AsyncStorage.removeItem(STORAGE_KEY_USER).catch(() => {});
                  setUser(null);
                  throw new Error(
                    `Your worker account (${cleanEmail}) is already bound to another mobile phone under ${freshOrg.churchName}. Please use your registered phone or contact your administrator to release your device.`
                  );
                }

                activeOrg = freshOrg;
                existingMember = {
                  id: memberDoc.id,
                  ...mData,
                  fullName: mData.fullName || authUser.displayName || 'Worker',
                  phone: mData.phone || '',
                  email: mData.email || cleanEmail,
                  department: mData.department || 'General',
                  boundDeviceId: boundDev && boundDev !== 'UNBOUND' ? boundDev : activeDeviceId,
                  registeredAt: mData.registeredAt || new Date().toISOString(),
                  isFaceEnrolled: Boolean(mData.isFaceEnrolled),
                  faceEmbedding: mData.faceEmbedding || [],
                  facePhotoURL: mData.facePhotoURL,
                } as ChurchMember;

                existingMember = await hydrateMemberWithLocalFaceVault(existingMember, freshOrg.id);
                if (activeDeviceId) {
                  await saveDeviceWorkerLock({
                    deviceId: activeDeviceId,
                    memberId: existingMember.id,
                    email: cleanEmail,
                    fullName: existingMember.fullName,
                    orgId: freshOrg.id,
                    orgName: freshOrg.churchName,
                    boundAt: new Date().toISOString(),
                  });
                }
                setOrganization(activeOrg);
                await cacheOrganizationAnchors(activeOrg);
              }
            }
          }
        } catch (cgErr) {
          if (
            cgErr instanceof Error &&
            (cgErr.message.includes('already bound') ||
              cgErr.message.includes('still registered') ||
              cgErr.message.includes('Only one worker'))
          ) {
            throw cgErr;
          }
          console.warn('Cross-organization member lookup notice:', cgErr);
        }
      }

      if (existingMember) {
        setAuthStepLabel('Syncing profile & biometrics...');
        existingMember = await hydrateMemberWithLocalFaceVault(
          existingMember,
          activeOrg?.id
        );
        await AsyncStorage.setItem(STORAGE_KEY_MEMBER, JSON.stringify(existingMember));
      } else {
        await AsyncStorage.removeItem(STORAGE_KEY_MEMBER);
      }

      // Commit organization, member, and user together in one synchronous React render batch
      setOrganization(activeOrg);
      setMember(existingMember);
      setUser(authUser);

      return {
        user: authUser,
        organization: activeOrg,
        member: existingMember,
      };
      } finally {
        setAuthStepLabel(null);
      }
    },
    [organization, deviceId]
  );

  const signInWithGoogle = async (customUser?: Partial<MobileUser>): Promise<AuthResult> => {
    try {
      const requestedAdmin = customUser?.isAdmin === true;
      if (Platform.OS === 'web' && !customUser?.uid) {
        const cred = await FirebaseAuth.signInWithPopup(auth, googleProvider);
        const isNewUser = FirebaseAuth.getAdditionalUserInfo(cred)?.isNewUser;
        const effectiveEmail = cred.user.email || 'user@gmail.com';
        const effectiveName = cred.user.displayName || cred.user.email?.split('@')[0] || 'Workforce Member';

        if (requestedAdmin) {
          await promoteEmailToAdminIfNotActiveWorker({
            email: effectiveEmail,
            uid: cred.user.uid,
            displayName: effectiveName,
            deviceId,
          });
        }

        const isAdminUser =
          requestedAdmin || (await checkIfUserIsAdmin(effectiveEmail, cred.user.uid));

        if (isNewUser && effectiveEmail) {
          const role: 'ADMIN' | 'WORKER' = isAdminUser ? 'ADMIN' : 'WORKER';
          if (db) {
            await setDoc(
              doc(db, isAdminUser ? 'admins' : 'workers', cred.user.uid),
              {
                uid: cred.user.uid,
                email: effectiveEmail.toLowerCase(),
                displayName: effectiveName,
                role,
                authProvider: 'google',
                createdAt: Date.now(),
              },
              { merge: true }
            ).catch(() => {});
          }
          sendMobileWelcomeEmail(effectiveEmail, effectiveName, role).catch((e) =>
            console.warn('[Welcome Email Mobile - Google Web] Dispatch notice:', e)
          );
        }

        const authUser: MobileUser = {
          uid: cred.user.uid,
          email: effectiveEmail,
          displayName: effectiveName,
          photoURL: cred.user.photoURL || undefined,
          isAdmin: isAdminUser,
        };
        return await handleUserAuthenticated(authUser);
      }

      const authUser: MobileUser = {
        uid: customUser?.uid || 'google_uid_' + Date.now().toString(36),
        email: customUser?.email || 'staff.member@gmail.com',
        displayName: customUser?.displayName || 'Workforce Member',
        photoURL: customUser?.photoURL,
        isAdmin: customUser?.isAdmin,
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
      setAuthStepLabel('Verifying Google session...');
      const credential = FirebaseAuth.GoogleAuthProvider.credential(idToken);
      const cred = await FirebaseAuth.signInWithCredential(auth, credential);
      const isNewUser = FirebaseAuth.getAdditionalUserInfo(cred)?.isNewUser;
      const effectiveEmail = (cred.user.email || profileHint?.email || '').trim();
      const effectiveName =
        cred.user.displayName ||
        profileHint?.displayName ||
        effectiveEmail.split('@')[0] ||
        'Workforce Member';
      const effectivePhoto = cred.user.photoURL || profileHint?.photoURL || undefined;
      const requestedAdmin = profileHint?.isAdmin === true;

      if (requestedAdmin && effectiveEmail) {
        await promoteEmailToAdminIfNotActiveWorker({
          email: effectiveEmail,
          uid: cred.user.uid,
          displayName: effectiveName,
          deviceId,
        });
      }

      const isAdminUser =
        requestedAdmin || (await checkIfUserIsAdmin(effectiveEmail, cred.user.uid));

      if (isNewUser && effectiveEmail) {
        const role: 'ADMIN' | 'WORKER' = isAdminUser ? 'ADMIN' : 'WORKER';
        if (db) {
          await setDoc(
            doc(db, isAdminUser ? 'admins' : 'workers', cred.user.uid),
            {
              uid: cred.user.uid,
              email: effectiveEmail.toLowerCase(),
              displayName: effectiveName,
              role,
              authProvider: 'google',
              createdAt: Date.now(),
            },
            { merge: true }
          ).catch(() => {});
        }
        sendMobileWelcomeEmail(effectiveEmail, effectiveName, role).catch((e) =>
          console.warn('[Welcome Email Mobile - Google] Dispatch notice:', e)
        );
      }

      const authUser: MobileUser = {
        uid: cred.user.uid,
        email: effectiveEmail,
        displayName: effectiveName,
        photoURL: effectivePhoto,
        isAdmin: isAdminUser,
      };
      return await handleUserAuthenticated(authUser);
    } catch (error) {
      setAuthStepLabel(null);
      console.warn('Firebase Google Credential Sign-In notice:', error);
      throw error;
    }
  };

  const addOrSelectGoogleAccount = async (selectedAccount: MobileUser): Promise<AuthResult> => {
    return await handleUserAuthenticated(selectedAccount);
  };

  // Email & Password Authentication: Sign In (Auto-detects role on login)
  const loginWithEmailPassword = async (email: string, password: string): Promise<AuthResult> => {
    const cleanEmail = email.trim().toLowerCase();
    try {
      setAuthStepLabel('Authenticating account...');
      const cred = await FirebaseAuth.signInWithEmailAndPassword(auth, cleanEmail, password);
      const authUser: MobileUser = {
        uid: cred.user.uid,
        email: cred.user.email || cleanEmail,
        displayName: cred.user.displayName || cred.user.email?.split('@')[0] || 'User',
        photoURL: cred.user.photoURL || undefined,
      };
      // handleUserAuthenticated auto-detects Admin vs Worker role!
      return await handleUserAuthenticated(authUser);
    } catch (error: any) {
      setAuthStepLabel(null);
      console.error('[Login] Email & Password login failed:', error);
      throw error;
    }
  };

  // Role-Based Registration: Create Account with chosen role ('ADMIN' or 'WORKER')
  const registerWithEmailPassword = async (
    email: string,
    password: string,
    displayName: string,
    role: 'ADMIN' | 'WORKER'
  ): Promise<AuthResult> => {
    const cleanEmail = email.trim().toLowerCase();
    try {
      setAuthStepLabel('Creating account...');
      const cred = await FirebaseAuth.createUserWithEmailAndPassword(auth, cleanEmail, password);

      if (cred.user && displayName.trim()) {
        await FirebaseAuth.updateProfile(cred.user, {
          displayName: displayName.trim(),
        }).catch(() => {});
      }

      // Persist role metadata in Firestore
      setAuthStepLabel('Assigning account role...');
      if (db) {
        if (role === 'ADMIN') {
          await promoteEmailToAdminIfNotActiveWorker({
            email: cleanEmail,
            uid: cred.user.uid,
            displayName: displayName.trim(),
            deviceId,
          });
        } else {
          await setDoc(
            doc(db, 'workers', cred.user.uid),
            {
              uid: cred.user.uid,
              email: cleanEmail,
              displayName: displayName.trim(),
              role: 'WORKER',
              createdAt: Date.now(),
            },
            { merge: true }
          );
        }
      }

      // Send Welcome Email immediately upon successful account creation
      sendMobileWelcomeEmail(cleanEmail, displayName, role).catch((err) =>
        console.warn('[Welcome Email Mobile] Dispatch notice:', err)
      );

      const authUser: MobileUser = {
        uid: cred.user.uid,
        email: cleanEmail,
        displayName: displayName.trim() || cleanEmail.split('@')[0],
        isAdmin: role === 'ADMIN',
      };

      return await handleUserAuthenticated(authUser);
    } catch (error: any) {
      console.error('[Register] Email registration error:', error);
      throw error;
    }
  };

  // Send 6-digit OTP code to email
  const sendMobileOtp = async (
    email: string,
    purpose: 'SIGNUP' | 'RESET_PASSWORD',
    intendedRole?: 'ADMIN' | 'WORKER'
  ): Promise<SendMobileOtpResult> => {
    const cleanEmail = email.trim().toLowerCase();
    if (purpose === 'SIGNUP') {
      const isAdminEmail =
        intendedRole === 'ADMIN' || (await checkIfUserIsAdmin(cleanEmail));
      if (!isAdminEmail) {
        const activeDeviceId = deviceId || (await getDeviceFingerprint());
        await enforceDeviceWorkerLock({
          deviceId: activeDeviceId,
          candidateEmail: cleanEmail,
        });
      }
      return await sendMobileSignupOtp(email);
    } else {
      return await sendMobilePasswordResetOtp(email);
    }
  };

  // Verify 6-digit OTP code
  const verifyMobileOtpCode = async (
    email: string,
    code: string,
    purpose: 'SIGNUP' | 'RESET_PASSWORD'
  ): Promise<boolean> => {
    return await verifyMobileOtp(email, code, purpose);
  };

  // Reset password using 6-digit code
  const resetPasswordWithOtp = async (
    email: string,
    code: string,
    newPassword: string
  ): Promise<void> => {
    await verifyMobileOtp(email, code, 'RESET_PASSWORD');
    const cleanEmail = email.trim().toLowerCase();
    if (auth.currentUser && auth.currentUser.email?.toLowerCase() === cleanEmail) {
      await FirebaseAuth.updatePassword(auth.currentUser, newPassword);
    } else {
      // Send Firebase reset email or update in backend
      await FirebaseAuth.sendPasswordResetEmail(auth, cleanEmail);
    }
  };

  const pairOrganization = async (code: string): Promise<Organization> => {
    const org = await fetchOrganizationByCode(code);
    if (!org) {
      throw new Error('No organization found matching code "' + code.toUpperCase() + '". Please verify with your administrator.');
    }

    const activeDeviceId = deviceId || (await getDeviceFingerprint());
    await enforceDeviceWorkerLock({
      deviceId: activeDeviceId,
      candidateEmail: user?.email,
      targetOrgId: org.id,
    });

    const anchors = await cacheOrganizationAnchors(org);
    setOrganization(org);
    setCachedAnchors(anchors);

    if (user && activeDeviceId) {
      const existing = await findExistingMember(org.id, user.email, activeDeviceId);
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

    try {
      setAuthStepLabel('Checking role & device...');
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

      setAuthStepLabel('Uploading biometrics & saving...');
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
    } finally {
      setAuthStepLabel(null);
    }
  };

  const enrollFace = async (faceEmbedding: number[], facePhotoURL?: string): Promise<void> => {
    if (!organization?.id || !member?.id) {
      throw new Error('No active organization or member profile found.');
    }
    const enrolledAt = new Date().toISOString();
    if (facePhotoURL) {
      await saveFaceToLocalVault({
        facePhotoURL,
        faceEmbedding,
        faceEnrolledAt: enrolledAt,
        email: member.email || user?.email,
        memberId: member.id,
        orgId: organization.id,
      });
    }
    await updateMemberFaceEnrollment(organization.id, member.id, faceEmbedding, facePhotoURL);
    const updatedMember: ChurchMember = {
      ...member,
      faceEmbedding,
      isFaceEnrolled: true,
      faceEnrolledAt: enrolledAt,
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
        STORAGE_KEY_ORG,
        STORAGE_KEY_ANCHORS,
        STORAGE_KEY_KNOWN_ACCOUNTS,
      ]);
      setUser(null);
      setMember(null);
      setOrganization(null);
      setCachedAnchors(null);
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

  const createAdminOrg = useCallback(
    async (params: {
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
    }): Promise<Organization> => {
      if (!user) throw new Error('Administrator session required.');
      const created = await createAdminOrganization({
        uid: user.uid,
        adminEmail: user.email,
        ...params,
      });
      setOrganization(created);
      const anchors = await cacheOrganizationAnchors(created);
      setCachedAnchors(anchors);
      return created;
    },
    [user]
  );

  const updateOrgSettings = useCallback(
    async (updates: {
      churchName: string;
      branchName: string;
      departments: string[];
      policySettings: import('../types').PolicySettings;
    }): Promise<void> => {
      if (!organization?.id) throw new Error('No active organization workspace.');
      await updateOrganizationSettings(organization.id, updates);
      const updatedOrg: Organization = {
        ...organization,
        churchName: updates.churchName.trim(),
        branchName: updates.branchName.trim() || 'Main Campus',
        departments: updates.departments.length > 0 ? updates.departments : ['General Workforce'],
        policySettings: updates.policySettings,
      };
      setOrganization(updatedOrg);
      await AsyncStorage.setItem(STORAGE_KEY_ORG, JSON.stringify(updatedOrg)).catch(() => {});
    },
    [organization]
  );

  const deleteAdminOrg = useCallback(async (): Promise<void> => {
    if (!organization?.id) return;
    await deleteAdminOrganizationWorkspace(organization.id, user?.email);
    setOrganization(null);
    setCachedAnchors(null);
  }, [organization?.id, user?.email]);

  return (
    <AuthContext.Provider
      value={{
        user,
        organization,
        member,
        cachedAnchors,
        deviceId,
        isLoading,
        authStepLabel,
        isAdmin: Boolean(user?.isAdmin),
        knownAccounts,
        loginWithEmailPassword,
        registerWithEmailPassword,
        sendMobileOtp,
        verifyMobileOtpCode,
        resetPasswordWithOtp,
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
        createAdminOrg,
        updateOrgSettings,
        deleteAdminOrg,
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

