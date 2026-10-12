export interface Organization {
  id: string;
  churchName: string;
  branchName: string;
  churchCode: string;
  adminName?: string;
  adminEmail?: string;
  adminPhone?: string;
  departments: string[];
  beaconConfig: {
    ssidHint: string;
    targetBssid: string;
  };
  geoFallback: {
    latitude: number;
    longitude: number;
    radiusMeters: number;
  };
  policySettings?: {
    serviceDays: string[];
    arrivalCutoff: string;
    lateTolerance: number;
    syncCutoff: string;
  };
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
  deviceId: string;
  bssidDetected?: string;
  coordinatesDetected?: {
    latitude: number;
    longitude: number;
    accuracy?: number;
  };
}
