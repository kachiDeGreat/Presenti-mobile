import React, { useState, useRef, useEffect, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Easing,
  ActivityIndicator,
  Vibration,
  Image,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import { RNMLKitFaceDetector } from "@infinitered/react-native-mlkit-face-detection";
import {
  verifyFaceEnrollment,
  verifyFaceMatch,
} from "../services/aiFaceVerificationService";
import { C, MONO, R, S, T, shadow, ui } from "../constants/premium";

export type FaceScannerMode = "enroll" | "verify";

interface FaceScannerModalProps {
  visible: boolean;
  mode: FaceScannerMode;
  referencePhotoUrl?: string;
  onSuccess: (capturedDataUri: string) => void;
  onCancel: () => void;
  onFallbackBiometric?: () => void;
}

type ScanState = "ready" | "aligned" | "analyzing" | "confirm" | "success" | "error";

export const FaceScannerModal: React.FC<FaceScannerModalProps> = ({
  visible,
  mode,
  referencePhotoUrl,
  onSuccess,
  onCancel,
  onFallbackBiometric,
}) => {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanState, setScanState] = useState<ScanState>("ready");
  const [capturedUri, setCapturedUri] = useState<string | null>(null);
  const [pictureSize, setPictureSize] = useState<string | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState(
    "Position your face inside the circle"
  );
  const [subMessage, setSubMessage] = useState(
    "Ensure good lighting and look directly at the camera"
  );

  const cameraRef = useRef<CameraView>(null);
  const detectorRef = useRef<RNMLKitFaceDetector | null>(null);
  const isMountedRef = useRef(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const scanSessionIdRef = useRef(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const errorResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const laserAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const clearPendingTimersAndAbort = useCallback(() => {
    scanSessionIdRef.current += 1;
    if (abortControllerRef.current) {
      try {
        abortControllerRef.current.abort();
      } catch {}
      abortControllerRef.current = null;
    }
    if (errorResetTimerRef.current) {
      clearTimeout(errorResetTimerRef.current);
      errorResetTimerRef.current = null;
    }
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, []);

  const handleCameraReady = useCallback(async () => {
    try {
      if (!cameraRef.current) return;
      const sizes = await cameraRef.current.getAvailablePictureSizesAsync();
      if (!Array.isArray(sizes) || sizes.length === 0) return;

      // Pick a fast, compact 480p–720p resolution (~20-45KB JPEG) for 1-3s verification
      const parsed = sizes
        .map((raw) => {
          const parts = raw.split("x").map((n) => parseInt(n, 10));
          if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
          const maxDim = Math.max(parts[0], parts[1]);
          const minDim = Math.min(parts[0], parts[1]);
          return { raw, maxDim, minDim };
        })
        .filter((x): x is { raw: string; maxDim: number; minDim: number } => Boolean(x));

      const ideal = parsed
        .filter((s) => s.maxDim >= 640 && s.maxDim <= 960 && s.minDim >= 480)
        .sort((a, b) => a.maxDim - b.maxDim)[0];

      const fallbackMedium = parsed
        .filter((s) => s.maxDim >= 640 && s.maxDim <= 1280)
        .sort((a, b) => a.maxDim - b.maxDim)[0];

      const fallbackSmall = parsed.sort((a, b) => a.maxDim - b.maxDim)[0];
      const chosen = ideal?.raw || fallbackMedium?.raw || fallbackSmall?.raw;
      if (chosen && isMountedRef.current) {
        setPictureSize(chosen);
      }
    } catch {
      // Ignore if device camera driver does not report picture sizes
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearPendingTimersAndAbort();
    };
  }, [clearPendingTimersAndAbort]);

  // Initialize fast on-device ML Kit face detector for instant 100ms "No face detected" pre-check
  useEffect(() => {
    if (!visible) return;
    if (!detectorRef.current) {
      try {
        detectorRef.current = new RNMLKitFaceDetector({
          performanceMode: "fast",
          landmarkMode: false,
          contourMode: false,
          classificationMode: true,
          minFaceSize: 0.15,
        });
      } catch {
        detectorRef.current = null;
      }
    }
  }, [visible]);

  const resetToLiveCamera = useCallback(() => {
    clearPendingTimersAndAbort();
    setCapturedUri(null);
    setScanState("ready");
    setStatusMessage("Position your face inside the circle");
    setSubMessage(
      mode === "enroll"
        ? "One-time setup: center your face in good lighting"
        : "Look directly into the frame to confirm attendance"
    );
  }, [mode, clearPendingTimersAndAbort]);

  const handleCloseModal = useCallback(() => {
    clearPendingTimersAndAbort();
    setScanState("ready");
    onCancel();
  }, [clearPendingTimersAndAbort, onCancel]);

  // Show error for 3 seconds, stop verification, and automatically reset to ready state for a new scan
  const showErrorAndAutoReset = useCallback(
    (title: string, subtitle: string, vibrationPattern: number | number[] = 110) => {
      clearPendingTimersAndAbort();
      if (!isMountedRef.current || !visibleRef.current) return;
      setScanState("error");
      setStatusMessage(title);
      setSubMessage(subtitle);
      try {
        Vibration.vibrate(vibrationPattern);
      } catch {}

      errorResetTimerRef.current = setTimeout(() => {
        if (!isMountedRef.current || !visibleRef.current) return;
        setScanState("ready");
        setStatusMessage("Position your face inside the circle");
        setSubMessage(
          mode === "enroll"
            ? "Ready for new scan — center your face in good lighting"
            : "Ready for new scan — look directly into the frame"
        );
      }, 3000);
    },
    [clearPendingTimersAndAbort, mode]
  );

  // Reset state whenever modal opens or closes
  useEffect(() => {
    if (visible) {
      resetToLiveCamera();
      if (permission && !permission.granted && permission.canAskAgain) {
        requestPermission().catch(() => {});
      }
    } else {
      clearPendingTimersAndAbort();
    }
  }, [visible, resetToLiveCamera, clearPendingTimersAndAbort]);

  // Laser scan beam animation during analysis
  useEffect(() => {
    if (scanState === "analyzing") {
      laserAnim.setValue(0);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(laserAnim, {
            toValue: 1,
            duration: 900,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(laserAnim, {
            toValue: 0,
            duration: 900,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [scanState, laserAnim]);

  // Subtle breathing ring pulse while ready
  useEffect(() => {
    if (scanState === "ready") {
      const pulse = Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 1.03,
            duration: 1050,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1050,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
      pulse.start();
      return () => pulse.stop();
    } else {
      pulseAnim.setValue(1);
    }
  }, [scanState, pulseAnim]);

  const handleCaptureAndVerify = async () => {
    if (
      !cameraRef.current ||
      scanState === "analyzing" ||
      scanState === "success" ||
      scanState === "confirm"
    ) {
      return;
    }

    clearPendingTimersAndAbort();
    const sessionId = scanSessionIdRef.current;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setScanState("analyzing");
    setStatusMessage("Scanning face...");
    setSubMessage("Hold still for 1–2 seconds");

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.22,
        shutterSound: false,
      });

      if (
        !isMountedRef.current ||
        !visibleRef.current ||
        scanSessionIdRef.current !== sessionId ||
        controller.signal.aborted
      ) {
        return;
      }

      if (!photo?.base64) {
        showErrorAndAutoReset(
          "Could not capture frame",
          "Hold steady and try again."
        );
        return;
      }

      // Instant ~100ms on-device pre-check: immediately catch empty/no-face frames before cloud AI
      let localFaceConfirmed = false;
      if (detectorRef.current?.status === "ready" && photo.uri) {
        try {
          const localDet = await detectorRef.current.detectFaces(photo.uri);
          if (
            !isMountedRef.current ||
            !visibleRef.current ||
            scanSessionIdRef.current !== sessionId
          ) {
            return;
          }
          const faces = localDet?.faces || [];
          if (faces.length === 0) {
            showErrorAndAutoReset(
              "No face detected",
              "Point the camera directly at your face in good light.",
              100
            );
            return;
          }
          if (faces.length > 1) {
            showErrorAndAutoReset(
              "Multiple faces in frame",
              "Only one person should be visible inside the circle.",
              100
            );
            return;
          }
          localFaceConfirmed = true;
        } catch {
          // Continue to Gemini AI if local detector throws
        }
      }

      const dataUri = `data:image/jpeg;base64,${photo.base64}`;

      if (mode === "enroll") {
        const res = await verifyFaceEnrollment(photo.base64);
        if (
          !isMountedRef.current ||
          !visibleRef.current ||
          scanSessionIdRef.current !== sessionId
        ) {
          return;
        }

        if (res.valid) {
          setCapturedUri(dataUri);
          setScanState("confirm");
          setStatusMessage("Confirm Your Photo");
          setSubMessage("Make sure your face is clear, or retake below.");
          Vibration.vibrate([0, 50, 40, 50]);
        } else if (
          localFaceConfirmed &&
          res.reason === "Verification service busy."
        ) {
          // If Gemini quota/network is temporarily busy during enrollment AND local face detection
          // already confirmed a single clear face, let user confirm their photo instead of stranding them
          setCapturedUri(dataUri);
          setScanState("confirm");
          setStatusMessage("Confirm Your Photo");
          setSubMessage("Make sure your face is clear, or retake below.");
          Vibration.vibrate([0, 50, 40, 50]);
        } else {
          showErrorAndAutoReset(
            res.reason || "Face Not Clear",
            res.guidance,
            120
          );
        }
      } else {
        const res = await verifyFaceMatch(
          photo.base64,
          referencePhotoUrl || ""
        );
        if (
          !isMountedRef.current ||
          !visibleRef.current ||
          scanSessionIdRef.current !== sessionId
        ) {
          return;
        }

        if (res.verified) {
          setScanState("success");
          setStatusMessage("Biometric Identity Verified");
          setSubMessage(`Match confidence: ${Math.round(res.confidence)}%`);
          Vibration.vibrate([0, 60, 40, 60]);
          successTimerRef.current = setTimeout(() => {
            if (
              !isMountedRef.current ||
              !visibleRef.current ||
              scanSessionIdRef.current !== sessionId
            ) {
              return;
            }
            onSuccess(dataUri);
          }, 500);
        } else {
          // Wrong face or liveness failed -> stop verification, show error for 3s, then auto-reset
          showErrorAndAutoReset(
            !res.isLivePerson ? "Liveness Check Failed" : "Verification Failed",
            res.reason,
            [0, 100, 60, 100]
          );
        }
      }
    } catch (err: any) {
      if (
        !isMountedRef.current ||
        !visibleRef.current ||
        scanSessionIdRef.current !== sessionId ||
        controller.signal.aborted
      ) {
        return;
      }
      showErrorAndAutoReset(
        "Camera Scan Interrupted",
        err?.message || "Please center your face and try again."
      );
    }
  };

  const ringColor =
    scanState === "success" || scanState === "confirm" || scanState === "aligned"
      ? C.success
      : scanState === "error"
      ? C.danger
      : scanState === "analyzing"
      ? C.warn
      : C.accent;

  const statusBg =
    scanState === "success" || scanState === "confirm" || scanState === "aligned"
      ? C.successSoft
      : scanState === "error"
      ? C.dangerSoft
      : scanState === "analyzing"
      ? C.warnSoft
      : C.accentSoft;

  const laserTranslateY = laserAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [20, 232],
  });

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      statusBarTranslucent
      onRequestClose={handleCloseModal}
    >
      <View
        style={[
          styles.container,
          {
            paddingTop: Math.max(insets.top, 20) + 10,
            paddingBottom: Math.max(insets.bottom, 16) + 12,
          },
        ]}
      >
        {/* Light Editorial Header */}
        <View style={styles.topBar}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={styles.topTag}>
              {mode === "enroll" ? "BIOMETRIC ENROLLMENT" : "PRESENCE VERIFICATION"}
            </Text>
            <Text style={styles.topTitle}>
              {mode === "enroll" ? "Register Your Face" : "Face Biometric Scan"}
            </Text>
          </View>
          <TouchableOpacity onPress={handleCloseModal} style={styles.closeBtn} activeOpacity={0.7}>
            <Ionicons name="close" size={20} color={C.ink} />
          </TouchableOpacity>
        </View>

        {/* Floating Guidance Card */}
        <View style={styles.guidanceCard}>
          <View style={[styles.guidanceDotWrap, { backgroundColor: statusBg }]}>
            <View style={[styles.guidanceDot, { backgroundColor: ringColor }]} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.guidanceTitle, { color: ringColor === C.accent ? C.ink : ringColor }]}>
              {statusMessage}
            </Text>
            <Text style={styles.guidanceSub}>{subMessage}</Text>
          </View>
        </View>

        {/* Circular Floating Camera / Confirmation Portal */}
        <View style={styles.portalWrapper}>
          {!permission?.granted ? (
            <View style={styles.permissionBox}>
              <View style={ui.iconBubble}>
                <Ionicons name="camera-outline" size={24} color={C.accent} />
              </View>
              <Text style={styles.permissionTitle}>Camera Access Required</Text>
              <Text style={styles.permissionSub}>
                Presenti needs front camera access to verify your live facial identity.
              </Text>
              <TouchableOpacity
                style={styles.permissionBtn}
                onPress={requestPermission}
                activeOpacity={0.85}
              >
                <Text style={styles.permissionBtnText}>ALLOW CAMERA ACCESS</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.portalGroup}>
              <Animated.View
                style={[
                  styles.outerRing,
                  {
                    borderColor: ringColor,
                    transform: [{ scale: pulseAnim }],
                  },
                ]}
              >
                <View style={styles.circleMask}>
                  {scanState === "confirm" && capturedUri ? (
                    <Image
                      source={{ uri: capturedUri }}
                      style={styles.camera}
                      resizeMode="cover"
                    />
                  ) : (
                    <CameraView
                      ref={cameraRef}
                      style={styles.camera}
                      facing="front"
                      pictureSize={pictureSize}
                      onCameraReady={handleCameraReady}
                    />
                  )}

                  {/* Dotted Face Alignment Oval */}
                  {scanState !== "success" && scanState !== "confirm" && (
                    <View
                      style={[
                        styles.faceGuideOval,
                        scanState === "aligned" && styles.faceGuideOvalAligned,
                      ]}
                      pointerEvents="none"
                    />
                  )}

                  {/* Laser Scan Beam */}
                  {scanState === "analyzing" && (
                    <Animated.View
                      style={[
                        styles.laserLine,
                        { transform: [{ translateY: laserTranslateY }] },
                      ]}
                      pointerEvents="none"
                    />
                  )}

                  {/* Success Checkmark Overlay */}
                  {scanState === "success" && (
                    <View style={styles.successOverlay}>
                      <View style={styles.successCheckCircle}>
                        <Ionicons name="checkmark" size={48} color="#ffffff" />
                      </View>
                    </View>
                  )}
                </View>
              </Animated.View>

              <View style={styles.securityPill}>
                <Ionicons name="shield-checkmark" size={13} color={C.accent} />
                <Text style={styles.securityPillText}>
                  {scanState === "confirm"
                    ? "PREVIEW & CONFIRM CAPTURE"
                    : "LIVENESS & ANTI-SPOOFING ACTIVE"}
                </Text>
              </View>
            </View>
          )}
        </View>

        {/* Bottom Action Dock */}
        <View style={styles.bottomActions}>
          {permission?.granted && scanState === "confirm" && capturedUri ? (
            <View style={{ gap: 10 }}>
              <TouchableOpacity
                style={[styles.scanBtn, { backgroundColor: C.success }]}
                onPress={() => onSuccess(capturedUri)}
                activeOpacity={0.85}
              >
                <Ionicons name="checkmark-circle" size={20} color="#ffffff" />
                <Text style={styles.scanBtnText}>USE THIS PHOTO</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.retakeSecondaryBtn}
                onPress={resetToLiveCamera}
                activeOpacity={0.8}
              >
                <Ionicons name="refresh" size={18} color={C.ink} />
                <Text style={styles.retakeSecondaryBtnText}>RETAKE PHOTO</Text>
              </TouchableOpacity>
            </View>
          ) : (
            permission?.granted && (
              <TouchableOpacity
                style={[
                  styles.scanBtn,
                  scanState === "aligned" && { backgroundColor: C.success },
                  scanState === "analyzing" && styles.scanBtnDisabled,
                  scanState === "success" && { backgroundColor: C.success },
                ]}
                onPress={handleCaptureAndVerify}
                disabled={scanState === "analyzing" || scanState === "success"}
                activeOpacity={0.85}
              >
                {scanState === "analyzing" ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : (
                  <Ionicons
                    name={
                      scanState === "success"
                        ? "checkmark-circle"
                        : "scan-outline"
                    }
                    size={20}
                    color="#ffffff"
                  />
                )}
                <Text style={styles.scanBtnText}>
                  {scanState === "analyzing"
                    ? "VERIFYING FACE..."
                    : scanState === "success"
                    ? "VERIFIED"
                    : scanState === "error"
                    ? "TRY SCAN AGAIN"
                    : mode === "enroll"
                    ? "CAPTURE & ENROLL FACE"
                    : "SCAN FACE TO VERIFY"}
                </Text>
              </TouchableOpacity>
            )
          )}

          {onFallbackBiometric &&
            scanState !== "success" &&
            scanState !== "confirm" && (
              <TouchableOpacity
                style={styles.fallbackBtn}
                onPress={onFallbackBiometric}
                disabled={scanState === "analyzing"}
                activeOpacity={0.75}
              >
                <Ionicons
                  name="finger-print-outline"
                  size={16}
                  color={C.ink2}
                />
                <Text style={styles.fallbackBtnText}>
                  Use Device Biometric / PIN Instead
                </Text>
              </TouchableOpacity>
            )}
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: C.canvas,
    paddingHorizontal: S.screenX,
    justifyContent: "space-between",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 10,
  },
  topTag: {
    ...T.labelSm,
    color: C.accent,
  },
  topTitle: {
    ...T.display,
    fontSize: 24,
    marginTop: 2,
  },
  closeBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
    ...shadow.card,
  },
  guidanceCard: {
    ...ui.card,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: S.md,
  },
  guidanceDotWrap: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
  },
  guidanceDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  guidanceTitle: {
    ...T.heading,
    fontSize: 15,
  },
  guidanceSub: {
    ...T.caption,
    fontSize: 12.5,
    marginTop: 2,
  },
  portalWrapper: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  portalGroup: {
    alignItems: "center",
    gap: 18,
  },
  outerRing: {
    width: 280,
    height: 280,
    borderRadius: 140,
    borderWidth: 5,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.card,
    ...shadow.raised,
  },
  circleMask: {
    width: 258,
    height: 258,
    borderRadius: 129,
    overflow: "hidden",
    position: "relative",
    backgroundColor: "#0f172a",
  },
  camera: {
    width: "100%",
    height: "100%",
  },
  faceGuideOval: {
    position: "absolute",
    top: 26,
    left: 44,
    right: 44,
    bottom: 26,
    borderRadius: 100,
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: "rgba(255, 255, 255, 0.65)",
  },
  faceGuideOvalAligned: {
    borderColor: C.success,
    borderWidth: 2.5,
  },
  laserLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: C.accent,
    shadowColor: C.accent,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 1,
    shadowRadius: 8,
  },
  successOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(18, 161, 80, 0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  successCheckCircle: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: C.success,
    alignItems: "center",
    justifyContent: "center",
  },
  securityPill: {
    ...ui.pill,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  securityPillText: {
    ...T.labelSm,
    fontSize: 10,
    color: C.ink2,
  },
  permissionBox: {
    ...ui.card,
    padding: S.lg,
    alignItems: "center",
    gap: 10,
    maxWidth: 340,
  },
  permissionTitle: {
    ...T.title,
    fontSize: 17,
  },
  permissionSub: {
    ...T.caption,
    textAlign: "center",
  },
  permissionBtn: {
    ...ui.btnPrimary,
    marginTop: 8,
    width: "100%",
  },
  permissionBtnText: {
    ...ui.btnPrimaryText,
  },
  bottomActions: {
    gap: 10,
  },
  scanBtn: {
    ...ui.btnPrimary,
    ...shadow.raised,
  },
  scanBtnDisabled: {
    opacity: 0.75,
  },
  scanBtnText: {
    ...ui.btnPrimaryText,
  },
  retakeSecondaryBtn: {
    ...ui.btnSecondary,
  },
  retakeSecondaryBtnText: {
    ...ui.btnSecondaryText,
  },
  fallbackBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
  },
  fallbackBtnText: {
    ...T.caption,
    color: C.ink2,
    fontWeight: "600",
  },
});
