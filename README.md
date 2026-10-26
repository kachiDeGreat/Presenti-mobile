# Presenti — Mobile Workforce & Presence Verification App

[![Expo](https://img.shields.io/badge/Expo-SDK%2052-000020?logo=expo&logoColor=white)](https://expo.dev/)
[![React Native](https://img.shields.io/badge/React%20Native-0.76-61DAFB?logo=react&logoColor=black)](https://reactnative.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Firebase](https://img.shields.io/badge/Firebase-Firestore%20%26%20Auth%20v13-FFCA28?logo=firebase&logoColor=black)](https://firebase.google.com/)
[![Google Sign-In](https://img.shields.io/badge/Auth-Google%20Native%20SSO-4285F4?logo=google&logoColor=white)](https://developers.google.com/identity)

**Presenti Mobile** is the client application for the Presenti workforce attendance and presence verification platform. Designed for modern workforces, institutions, and organizations, it guarantees verified physical presence using hardware radio scanning, satellite GPS geofencing, on-device facial recognition AI, native biometrics, and single-device cryptographic locks—eliminating proxy attendance, location spoofing, and buddy punching.

---

## Core Capabilities & Features

### 1. Hands-Free On-Device Face Recognition AI (Apple Face ID & Banking App Style)
- **128-Dimensional Landmark Embedding:** Detects 3D facial landmarks and contours using Google ML Kit and extracts a normalized, rotation-invariant 128-dimensional facial biometric embedding vector.
- **Ultra-Fast On-Device Matching:** Computes vector Cosine Similarity on device in under 350ms, comparing the live scan directly against the worker's enrolled facial vector.
- **3D Liveness & Anti-Spoofing Engine:** Compares frame variance over time to detect natural physiological micro-movements (breathing, micro-saccades). Strictly detects and rejects printed 2D paper photographs, tablet/laptop screen replays, and photo proxies.
- **Smooth Apple Face ID-Inspired Modal:** Clean circular oval reticle with real-time positioning feedback ("Hold steady", "Move closer", "Face centered") for a frictionless, banking-grade experience.
- **Firestore Payload Safety:** Automatically compresses captured face photos and uploads them to Firebase Storage (or retains micro-thumbnails <70KB), strictly preventing Firestore's 1,048,487-byte document limit from ever being exceeded.

### 2. Zero-Proxy Mandatory Native Biometrics
- **Hardware Isolation:** Scans run through native OS security boundaries (`AndroidX BiometricPrompt` & iOS `LocalAuthentication`) inside the Apple Secure Enclave / Android StrongBox.
- **Strict Enforcement (`disableDeviceFallback: true`):** Devices with fingerprint or Face ID hardware strictly require biometric scans, preventing workers from lending their unlocked phone and PIN to coworkers.
- **Graceful Fallback & Settings Deep Link:** Budget devices without biometric sensors automatically fall back to lockscreen credentials. When biometrics are not yet enrolled, an interactive dialog provides a one-tap **"Go to Settings"** button that deep-links directly into device Security & Biometrics Settings.

### 3. Mobile Leadership Command Center (`AdminHub.tsx`)
Administrators can toggle between Worker Mode (instant clock-in) and the **Admin Hub**:
- **Tab 1: Live Attendance Feed:**
  - Real-time stream of all worker clock-ins for today.
  - Live KPI cards: **Total Present**, **On-Time Arrivals**, **Late Arrivals**, and **Punctuality Rate**.
  - Worker search bar and department filtering tabs.
  - Feed clear action.
- **Tab 2: Presence Anchors & Direct On-Site Calibration:**
  - On-site sensor calibration performed directly on the phone without needing a computer.
  - Toggle between **Satellite Geofence (`GEOFENCE_ONLY`)** and **Hybrid Wi-Fi (`HYBRID`)**.
  - Physical Wi-Fi spectrum scanner automatically detects nearby access points and BSSID MAC addresses for office router binding.
  - Multi-tier satellite GPS acquisition with Android network provider prompt and indoor fallback.
  - Radius perimeter selector (10m, 20m, 30m, 50m, 100m).
  - Tapping **Save & Anchor** immediately writes configuration to Cloud Firestore with instant auto-sync back to the Admin Web Portal.

### 4. Dual Physical Presence Engine
The mobile application dynamically evaluates the organization's calibrated architecture:
- **Mode 1: Router-Free Satellite GPS Geofence (Default & Recommended):**
  - High-precision GPS perimeter checks (10m to 100m radius).
  - Sub-second verification with zero hardware overhead—ideal for modern offices, field operations, and pop-up venues.
- **Mode 2: Hybrid Physical Office Router (Dual-Tier):**
  - **Tier 1 — Hardware Wi-Fi Anchor (BSSID):** Scans the device's physical Wi-Fi radio for the organization's calibrated router MAC address (`targetBssid`).
  - **20-Second Hardware Scan Timeout:** If physical Wi-Fi scanning times out, the app automatically fails over to Tier 2 geofencing.
  - **Tier 2 — GPS Perimeter Geofencing:** Calculates distance from calibrated coordinates using high-accuracy native GPS (`expo-location`). Clock-in is approved only if within the calibrated perimeter.

### 5. Smart Policy Enforcement, Late Tagging & Biometric Sign-Out
- **Dynamic Day-Specific vs. Unified Schedules:**
  - Evaluates today's operating rules dynamically using `evaluateAttendanceWindow`.
  - When the organization uses **Different Times per Day (`PER_DAY`)**, the app automatically resolves today's specific day-of-week settings (`arrivalCutoff`, `lateTolerance`, `allowLateSignIn`, `enableSignOut`, and `signOutTime`).
  - Seamlessly falls back to unified default policy settings for backwards compatibility.
- **Window Open & Close Enforcement:** Displays real-time countdown to arrival window opening and closing.
- **Late Sign-In Tagging (`allowLateSignIn`):**
  - When late tolerance is enabled, arriving after the cutoff activates the amber **"Tap to Clock In (Late)"** action button.
  - Submitting stamps the record with an immutable **`LATE`** status tag displayed directly on the attendance card and synchronized to the admin dashboard.
  - If late tolerance is disabled, attendance strictly locks down once the window passes.
- **Biometric Departure Sign-Out (`enableSignOut`):**
  - Sign-out unlocks from the configured departure time (`signOutTime`, e.g., 05:00 PM) and remains available indefinitely until the next service day.
  - Protected with native biometrics to prevent proxy clock-outs.
- **Automatic Queue Flushing:**
  - Automatically caches punches locally in `AsyncStorage` and flushes all pending records to Cloud Firestore on app mount, foreground resume (`AppState === 'active'`), and manual pull-to-refresh.

### 6. Sub-Second Timestamp Trapping & Hardware Device Binding
- **Zero-Latency Trapping:** Traps the exact sub-second timestamp the millisecond the worker taps **"Tap to Clock In"**, shielding employees from slow cellular networks.
- **Hardware Device Lock:** Workers' accounts are permanently bound to their smartphone's unique hardware identifier, preventing multiple workers from clocking in from a single phone.

---

## System Architecture

```mermaid
sequenceDiagram
    actor Worker
    participant Mobile as Presenti Mobile
    participant NativeSec as Android / iOS Biometrics
    participant FaceAI as On-Device Face AI
    participant Radios as Wi-Fi & GPS Radios
    participant Cloud as Cloud Firestore

    Worker->>Mobile: Tap "Tap to Clock In"
    Mobile->>Mobile: 1. Trap arrival timestamp immediately
    Mobile->>NativeSec: 2. Request native biometric verification (Fingerprint / Face ID)
    alt Biometrics Failed or Cancelled
        NativeSec-->>Mobile: Authentication Denied
        Mobile-->>Worker: Block Clock-In ("Identity Verification Required")
    else Biometrics Approved
        NativeSec-->>Mobile: Identity Verified (Hardware Confirmed)
        Mobile->>FaceAI: 3. Verify facial embedding & 3D liveness
        alt Face Mismatch or Liveness Failed
            FaceAI-->>Mobile: Verification Failed
            Mobile-->>Worker: Block Clock-In ("Living face match required")
        else Face Verified
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
| **Face Recognition AI** | Google ML Kit Landmarks + On-Device Vector Cosine Similarity & 3D Liveness |
| **Authentication** | Google Sign-In Native SDK (`@react-native-google-signin/google-signin`) + Firebase Auth |
| **Database** | Firebase Firestore (Real-time snapshots & offline cache) + Firebase Storage |
| **Wi-Fi Hardware Scanner** | `react-native-wifi-reborn` / Native Network APIs |
| **Location & Geofencing** | `expo-location` (High accuracy native GPS with indoor fallback) |
| **Geocoding & Search** | Multi-tier engine: Google Maps API + Android Google Play Geocoder + Photon (Nigeria BBox) + Nominatim |
| **Camera** | `expo-camera` (`CameraView`) |
| **Local Storage** | `@react-native-async-storage/async-storage` |

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

4. Ensure `google-services.json` is present in the project root for Android builds.

### Building & Running

#### Development Build
```bash
# Build custom Development Client APK
npx eas-cli build -p android --profile development

# Start Metro dev server
npx expo start --dev-client
```

#### Standalone Preview APK
```bash
npx eas-cli build -p android --profile preview
```

---

## Git Branches

- `master`: Production development branch.
- `role-upgrade`: Active feature integration branch.
- `stable`: Verified, stable release checkpoint.

---

## Related Repositories

- **Admin Web Portal (React / Vite):** [kachiDeGreat/Presenti-web-admin](https://github.com/kachiDeGreat/Presenti-web-admin)
- **Live Admin Web Portal:** [https://presenti-admin-web.vercel.app](https://presenti-admin-web.vercel.app)

---

## License

Private & Proprietary — Developed for Presenti Workforce Systems.
