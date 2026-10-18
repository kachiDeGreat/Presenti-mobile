export interface Organization {
  id: string;
  churchName: string;
  branchName: string;
  churchCode: string;
  adminName?: string;
  adminEmail?: string;
  adminPhone?: string;
  adminUids?: string[];
  departments: string[];
  beaconConfig: {
    ssidHint: string;
    targetBssid: string;
    verificationMode?: 'HYBRID' | 'GEOFENCE_ONLY';
  };
  geoFallback: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
    isConfigured?: boolean;
    isCalibrated?: boolean;
  };
  policySettings?: PolicySettings;
  isCalibrated?: boolean;
}

export interface DaySchedule {
  arrivalCutoff?: string; // e.g. "07:00" (Window Open Time)
  lateTolerance?: string; // e.g. "07:30" (Window Close Time)
  allowLateSignIn?: boolean; // If true, workers can sign in after close time marked LATE
  enableSignOut?: boolean; // If true, workers can/must sign out
  signOutTime?: string; // e.g. "17:00" (Sign-out starts from this time; no close cutoff)
}

export interface PolicySettings {
  serviceDays?: (number | string)[];
  scheduleMode?: 'UNIFIED' | 'PER_DAY'; // 'UNIFIED' = same for all active days; 'PER_DAY' = custom per day
  arrivalCutoff?: string; // e.g. "07:00" (Default / Unified Window Open Time)
  lateTolerance?: string; // e.g. "07:30" (Default / Unified Window Close Time)
  allowLateSignIn?: boolean; // If true, workers can sign in after close time marked LATE
  enableSignOut?: boolean; // If true, workers can/must sign out
  signOutTime?: string; // e.g. "17:00" (Sign-out starts from this time; no close cutoff)
  daySchedules?: Record<number | string, DaySchedule>; // Custom schedules per day
  syncCutoff?: string;    // Deprecated/optional
}

export interface TodayPunchRecord {
  memberId: string;
  punchedAt: string;       // Exact ISO timestamp captured instantly
  displayTime: string;     // e.g. "08:24:15 AM"
  serviceDate: string;     // YYYY-MM-DD
  status: 'SYNCING' | 'SYNCED' | 'OFFLINE_CACHED';
  attendanceStatus?: 'ON_TIME' | 'LATE';
  verificationMethod: 'WIFI_BSSID' | 'GEO_FALLBACK';
  bssidDetected?: string;
  biometricVerification?: {
    verified: boolean;
    method: 'BIOMETRIC' | 'DEVICE_PASSCODE';
    biometricType?: string;
  };
  signedOutAt?: string;
  signOutDisplayTime?: string;
  signOutStatus?: 'SYNCING' | 'SYNCED' | 'OFFLINE_CACHED';
  attendanceDocId?: string; // Firestore document ID if synced
}

export interface CachedAnchors {
  churchId: string;
  churchName: string;
  branchName: string;
  churchCode: string;
  ssidHint: string;
  targetBssid: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  verificationMode?: 'HYBRID' | 'GEOFENCE_ONLY';
  cachedAt: string;
}

export interface ChurchMember {
  id: string;
  fullName: string;
  phone: string;
  email?: string;
  photoURL?: string;
  department: string;
  boundDeviceId: string;
  registeredAt: string;
}

export interface MobileUser {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  isAdmin?: boolean;
}

export interface AttendanceRecordInput {
  memberId: string;
  memberName: string;
  department: string;
  serviceDate: string;
  timestamp: string;
  punchedAt: string;
  syncedAt: string;
  verificationMethod: 'WIFI_BSSID' | 'GEO_FALLBACK';
  status?: 'ON_TIME' | 'LATE';
  signedOutAt?: string;
  signOutDisplayTime?: string;
  deviceId: string;
  bssidDetected?: string;
  coordinatesDetected?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
  biometricVerification?: {
    verified: boolean;
    method: 'BIOMETRIC' | 'DEVICE_PASSCODE';
    biometricType?: string;
  };
}
