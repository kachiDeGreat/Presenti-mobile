# Presenti — Mobile Workforce & Presence Verification App

[![Expo](https://img.shields.io/badge/Expo-SDK%2052-000020?logo=expo&logoColor=white)](https://expo.dev/)
[![React Native](https://img.shields.io/badge/React%20Native-0.76-61DAFB?logo=react&logoColor=black)](https://reactnative.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Firebase](https://img.shields.io/badge/Firebase-Firestore%20%26%20Auth%20v13-FFCA28?logo=firebase&logoColor=black)](https://firebase.google.com/)
[![Google Sign-In](https://img.shields.io/badge/Auth-Google%20Native%20SSO-4285F4?logo=google&logoColor=white)](https://developers.google.com/identity)

**Presenti Mobile** is the client application for the Presenti workforce attendance and presence verification platform. Designed for modern workforces, institutions, and organizations, it guarantees verified physical presence using hardware radio scanning, satellite GPS geofencing, and single-device cryptographic locks—eliminating proxy attendance, location spoofing, and buddy punching.

---

## Core Capabilities & Features

### 1. Zero-Proxy Mandatory Biometric Verification (Anti-Buddy Punching)
- **Built-In & Non-Optional:** Biometric identity verification is mandatory by default for all workers on every punch-in. It cannot be disabled, guaranteeing that the registered employee is physically present holding their device.
- **Hardware Isolation (Secure Enclave / Android StrongBox):** Interacts directly with native OS security modules via `expo-local-authentication`. Biometric ridge scans and facial geometry never leave device silicon.
- **Strict Biometric Enforcement (`disableDeviceFallback: true`):** On devices equipped with Fingerprint or Face ID hardware, the OS is strictly prevented from offering device passcode/PIN fallback. This closes the loophole where Worker A gives their unlocked phone and PIN to Worker B to punch in for them.
- **Graceful Budget Device Fallback:** If a worker's phone lacks biometric hardware entirely, the app seamlessly falls back to device lockscreen credentials (PIN/Pattern/Password).
- **Clear Actionable Guidance:** Workers are never left with ambiguous error messages. If a scan is cancelled or not recognized, the app explicitly instructs them how to place their finger and retry.
- **Direct "Go to Settings" Deep Link:** If a worker's device has not yet enrolled a fingerprint, Face ID, or screen lock, an interactive alert provides a one-tap **"Go to Settings"** button that automatically opens the device's **Security & Biometrics Settings**.

### 2. Instant Clock-In Timestamp Trapping
- **Zero-Latency Timestamp Capture:** Captures the exact sub-second timestamp the millisecond the worker taps **"Tap to Clock In"**.
- **Tamper-Resistant Clock:** Trapped arrival timestamps are stored locally before background network verification starts. Workers are never penalized for slow cellular networks or brief connectivity drops.

### 3. Dual-Mode Physical Presence Engine
The mobile application dynamically reads the organization's calibrated architecture:
- **Mode 1: Router-Free Satellite GPS Geofence (Default & Recommended):**
  - Completely bypasses physical router scanning for modern offices, field teams, pop-up events, and mobile workspaces.
  - Verifies presence directly against high-accuracy satellite GPS coordinates with sub-second response times.
- **Mode 2: Hybrid Physical Office Router (Optional Dual-Tier):**
  - **Tier 1 — Hardware Wi-Fi Anchor (BSSID):** Scans the device's physical Wi-Fi radio for the organization's calibrated router MAC address (`targetBssid`). This prevents clock-ins outside premises via fake SSIDs or mobile hotspot tethering.
  - **20-Second Hardware Scan Timeout:** If physical Wi-Fi scanning times out, the app automatically fails over to Tier 2 geofencing.
  - **Tier 2 — GPS Perimeter Geofencing:** Calculates distance from calibrated coordinates using high-accuracy native GPS (`expo-location`). Clock-in is approved only if within the calibrated perimeter (10m to 100m).
- **Offline Attendance Trapping:** If the venue loses internet connectivity, punch records are cryptographically tagged, stored in local cache (`AsyncStorage`), and automatically pushed to Cloud Firestore once connectivity resumes.

### 4. Hardware Device Binding
- **One Worker, One Device:** Upon onboarding, the worker's account is permanently bound to their smartphone's unique hardware identifier.
- **Account Sharing Prevention:** Signing in from another person's device is rejected, eliminating proxy clock-ins.

### 5. Administrator Premises Calibration Suite
- **Secret 5-Second Logo Gesture:** The calibration mode is completely invisible to regular workers. Administrators access it by pressing and holding the Presenti logo on the sign-in screen or header for 5 seconds.
- **QR Code Pairing Gateway:** Administrators scan a live session QR code displayed on the Admin Web Portal to pair their phone.
- **Instant Camera Dismissal:** The camera scanner unmounts the millisecond the QR payload is verified, revealing the interactive calibration screen.
- **Multi-Tiered Geocoding Engine:** Global and local venue search powered by OpenStreetMap Nominatim and Photon (Komoot), with coordinate parsing and Google Maps share link detection.
- **Interactive Search Suggestions Dropdown:** Displays instant matching locations and landmarks below the search bar with one-tap pinning.
- **Smooth Satellite Map Fly-To:** Automatically glides the Leaflet satellite view directly to the selected venue or coordinates.
- **Physical Spectrum Scanner:** Discovers nearby Wi-Fi access points, signal strength (RSSI), and exact router BSSID MAC addresses for binding.
- **Fast GPS Lock:** High-accuracy GPS sampling captures satellite coordinates for geofence anchoring.
- **Clean Disconnect Handling:** Tagged disconnect origins (`source: "MOBILE_APP"`) ensure exiting calibration from the phone never triggers false "session ended by web admin" toasts.

### 6. Streamlined Worker Onboarding & Google Sign-In
- **Native Google SSO:** Single sign-on powered by `@react-native-google-signin/google-signin` on Android/iOS and Firebase Auth.
- **Clean Root Navigation:** Dynamic full-screen initial boot flow ensuring zero split-screen or layout glitches.
- **Automated Organization Code Formatting:** Auto-inserts hyphens as workers type their organization code (`XX-XXX-XXX`, e.g., `KW-RTX-482`).
- **Dynamic Department Enrollment:** Dynamically loads department listings from the organization's cloud profile.

---

## System Architecture

```mermaid
sequenceDiagram
    actor Worker
    participant Mobile as Presenti Mobile
    participant NativeSec as Android / iOS Biometrics
    participant Radios as Wi-Fi & GPS Radios
    participant Cloud as Cloud Firestore

    Worker->>Mobile: Tap "Tap to Clock In"
    Mobile->>Mobile: 1. Trap local timestamp immediately
    Mobile->>NativeSec: 2. Request native biometric verification (Fingerprint / Face ID)
    alt Biometrics Failed or Cancelled
        NativeSec-->>Mobile: Authentication Denied
        Mobile-->>Worker: Block Clock-In ("Identity Verification Required")
    else Biometrics Approved
        NativeSec-->>Mobile: Identity Verified (Hardware Confirmed)
        alt Organization Mode: GEOFENCE_ONLY (Default)
            Mobile->>Radios: Query high-accuracy GPS coordinates
            Mobile->>Mobile: Evaluate distance vs. Geofence perimeter
        else Organization Mode: HYBRID
            Mobile->>Radios: Scan physical Wi-Fi BSSID (20s timeout)
            alt Wi-Fi BSSID Matches Anchor
                Mobile->>Cloud: Record Attendance (Method: WIFI_BSSID, Biometric: Verified)
            else Wi-Fi Unavailable / Timeout
                Mobile->>Radios: Query high-accuracy GPS coordinates
                Mobile->>Mobile: Evaluate distance vs. Geofence perimeter
            end
        end
        alt Inside Premises Perimeter
            Mobile->>Cloud: Record Attendance (Method: GEO_FALLBACK, Biometric: Verified)
            Cloud-->>Mobile: Sync Confirmed
        else Outside Premises Perimeter
            Mobile-->>Worker: Block Clock-In ("Not On-Premise")
        end
    end
```

---

## Tech Stack

| Component | Technology |
|---|---|
| **Framework** | React Native (Expo SDK 52) |
| **Routing** | Expo Router (File-based navigation) |
| **Language** | TypeScript 5.6 |
| **Biometric Security** | `expo-local-authentication` (Android BiometricPrompt & iOS LocalAuthentication) |
| **Authentication** | Google Sign-In Native SDK (`@react-native-google-signin/google-signin` 16.1.5) + Firebase Auth |
| **Database** | Firebase Firestore (Real-time snapshots & offline cache) |
| **Wi-Fi Hardware Scanner** | `react-native-wifi-reborn` / Native Network APIs |
| **Location & Geofencing** | `expo-location` (High accuracy native GPS) |
| **Geocoding & Search** | Multi-tier engine: Google Maps API + Android Google Play Geocoder + Photon (Nigeria BBox) + Nominatim |
| **Camera & QR** | `expo-camera` (`CameraView`) |
| **Local Storage** | `@react-native-async-storage/async-storage` |

---

## Location Calibration & Venue Search

The mobile calibration interface (`calibrate.tsx`) features an intelligent multi-tiered geocoding engine:
1. **State & City Abbreviation Expansion**: Automatically normalizes Nigerian state acronyms and shorthand (e.g. `CRS` &rarr; `Cross River State`, `FCT` &rarr; `Abuja`, `PH` &rarr; `Port Harcourt`, `LG` &rarr; `Lagos State`).
2. **Android Native Google Play Geocoder**: Utilizes device-native `Location.geocodeAsync` directly connected to Google Play Services on Android for 100% free, unlimited, high-precision address lookups.
3. **Google Maps Geocoding API**: Integrates with Google Maps Platform when `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` or `EXPO_PUBLIC_GOOGLE_SERVICES_API_KEY` is provided ($200 free monthly credit).
4. **Nigeria Country Scoping & Bounding Box**: Uses geographic bounds (`bbox=2.6769,4.2725,14.6778,13.8920` and `countrycodes=ng`) with boundary safety validation to guarantee queries never drift outside Nigeria (preventing false matches overseas).
5. **Raw Coordinates & Google Maps Link Parsing**: Direct paste support for Google Maps share links, `@lat,lng` URLs, and coordinate pairs (`lat, lng`).

---

## Getting Started

### Prerequisites
- Node.js 18.x or 20.x
- Expo CLI (`npx expo`)
- EAS CLI (`npm install -g eas-cli`)
- Android Studio / Android Device (for native development build)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/kachiDeGreat/Presenti-mobile.git
   cd Presenti-mobile
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Environment Variables:
   Create a `.env` file in the root directory:
   ```env
   EXPO_PUBLIC_FIREBASE_API_KEY=your_firebase_api_key
   EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
   EXPO_PUBLIC_FIREBASE_PROJECT_ID=your_project_id
   EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
   EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
   EXPO_PUBLIC_FIREBASE_APP_ID=your_app_id
   EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID=your_google_web_client_id.apps.googleusercontent.com
   ```

4. Ensure `google-services.json` is present in the project root:
   - Required by EAS and Android build tools for native Firebase and Google Play Services.

### Building & Running

#### Option A: Development Build (Live Coding & Fast Refresh)
1. Build the custom Development Client APK (required once or when adding native libraries):
   ```bash
   npx eas-cli build -p android --profile development
   ```
2. Install the generated `.apk` on your test device.
3. Start the Expo development server:
   ```bash
   npx expo start --dev-client
   ```
4. Scan the metro QR code using the installed development build to enjoy live hot-reloading.

#### Option B: Standalone Preview APK (Direct On-Device Testing)
To generate an independent, shareable test APK without needing a running computer:
```bash
npx eas-cli build -p android --profile preview
```

---

## Git Branches

- `master`: Production development branch.
- `stable`: Verified, stable release checkpoint.

---

## Related Repositories

- **Admin Web Portal (React / Vite):** [kachiDeGreat/Presenti-web-admin](https://github.com/kachiDeGreat/Presenti-web-admin)
- **Live Admin Web Portal:** [https://presenti-admin-web.vercel.app](https://presenti-admin-web.vercel.app)

---

## License

Private & Proprietary — Developed for Presenti Workforce Systems.
