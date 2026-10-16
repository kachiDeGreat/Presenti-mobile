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

export interface PolicySettings {
  serviceDays?: (number | string)[];
  arrivalCutoff?: string; // e.g. "08:00" (Window Open Time)
  lateTolerance?: string; // e.g. "09:00" (Window Close Time)
  syncCutoff?: string;    // e.g. "12:00"
}

export interface TodayPunchRecord {
  memberId: string;
  punchedAt: string;       // Exact ISO timestamp captured instantly
  displayTime: string;     // e.g. "08:24:15 AM"
  serviceDate: string;     // YYYY-MM-DD
  status: 'SYNCING' | 'SYNCED' | 'OFFLINE_CACHED';
  verificationMethod: 'WIFI_BSSID' | 'GEO_FALLBACK';
  bssidDetected?: string;
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
  deviceId: string;
  bssidDetected?: string;
  coordinatesDetected?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
}
