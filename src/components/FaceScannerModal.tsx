import React, { useState, useRef, useEffect } from "react";
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
  Platform,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import {
  verifyFaceEnrollment,
  verifyFaceMatch,
} from "../services/aiFaceVerificationService";

export type FaceScannerMode = "enroll" | "verify";

interface FaceScannerModalProps {
  visible: boolean;
  mode: FaceScannerMode;
  referencePhotoUrl?: string;
  onSuccess: (capturedDataUri: string) => void;
  onCancel: () => void;
  onFallbackBiometric?: () => void;
}

type ScanState = "ready" | "analyzing" | "success" | "error";

export const FaceScannerModal: React.FC<FaceScannerModalProps> = ({
  visible,
  mode,
  referencePhotoUrl,
  onSuccess,
  onCancel,
  onFallbackBiometric,
}) => {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanState, setScanState] = useState<ScanState>("ready");
  const [statusMessage, setStatusMessage] = useState(
    "Position your face inside the circle"
  );
  const [subMessage, setSubMessage] = useState(
    "Ensure good lighting and look directly at the camera"
  );

  const cameraRef = useRef<CameraView>(null);
  const laserAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Reset state whenever modal opens
  useEffect(() => {
    if (visible) {
      setScanState("ready");
      setStatusMessage("Position your face inside the circle");
      setSubMessage(
        mode === "enroll"
          ? "One-time setup: center your face in good lighting"
          : "Look directly into the frame to confirm attendance"
      );
      if (permission && !permission.granted && permission.canAskAgain) {
        requestPermission().catch(() => {});
      }
    }
  }, [visible, mode]);

  // Laser scan beam animation during analysis
  useEffect(() => {
    if (scanState === "analyzing") {
      laserAnim.setValue(0);
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(laserAnim, {
            toValue: 1,
            duration: 950,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(laserAnim, {
            toValue: 0,
            duration: 950,
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
            toValue: 1.04,
            duration: 1100,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 1100,
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
    if (!cameraRef.current || scanState === "analyzing" || scanState === "success") {
      return;
    }

    setScanState("analyzing");
    setStatusMessage("Hold still... Analyzing biometrics");
    setSubMessage("Checking live facial geometry & anti-spoofing");

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.28,
        shutterSound: false,
      });

      if (!photo?.base64) {
        setScanState("error");
        setStatusMessage("Could not capture frame");
        setSubMessage("Please hold steady and tap Scan again.");
        return;
      }

      const dataUri = `data:image/jpeg;base64,${photo.base64}`;

      if (mode === "enroll") {
        const res = await verifyFaceEnrollment(photo.base64);
        if (res.valid) {
          setScanState("success");
          setStatusMessage("Face Profile Enrolled");
          setSubMessage(res.guidance);
          Vibration.vibrate([0, 60, 40, 60]);
          setTimeout(() => {
            onSuccess(dataUri);
          }, 700);
        } else {
          setScanState("error");
          setStatusMessage(res.reason || "Face Not Clear");
          setSubMessage(res.guidance);
          Vibration.vibrate(120);
        }
      } else {
        const res = await verifyFaceMatch(photo.base64, referencePhotoUrl || "");
        if (res.verified) {
          setScanState("success");
          setStatusMessage("Biometric Identity Verified");
          setSubMessage(`Match confidence: ${Math.round(res.confidence)}%`);
          Vibration.vibrate([0, 60, 40, 60]);
          setTimeout(() => {
            onSuccess(dataUri);
          }, 700);
        } else {
          setScanState("error");
          setStatusMessage(
            !res.isLivePerson ? "Liveness Check Failed" : "Verification Failed"
          );
          setSubMessage(res.reason);
          Vibration.vibrate([0, 100, 60, 100]);
        }
      }
    } catch (err: any) {
      setScanState("error");
      setStatusMessage("Camera Scan Interrupted");
      setSubMessage(err?.message || "Please centre your face and try again.");
    }
  };

  const ringColor =
    scanState === "success"
      ? "#10b981"
      : scanState === "error"
      ? "#d92d20"
      : scanState === "analyzing"
      ? "#f59e0b"
      : "#2d81ff";

  const laserTranslateY = laserAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [20, 224],
  });

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={false}
      onRequestClose={onCancel}
    >
      <View style={styles.container}>
        {/* Top Bar */}
        <View style={styles.topBar}>
          <View>
            <Text style={styles.topTag}>
              {mode === "enroll" ? "// BIOMETRIC ENROLLMENT" : "// PRESENCE VERIFICATION"}
            </Text>
            <Text style={styles.topTitle}>
              {mode === "enroll" ? "Register Your Face" : "Face Biometric Scan"}
            </Text>
          </View>
          <TouchableOpacity onPress={onCancel} style={styles.closeBtn} activeOpacity={0.7}>
            <Ionicons name="close" size={20} color="#ffffff" />
          </TouchableOpacity>
        </View>

        {/* Guidance Pill */}
        <View style={[styles.guidanceBox, { borderColor: ringColor }]}>
          <Text style={[styles.guidanceTitle, { color: ringColor === "#2d81ff" ? "#93c5fd" : ringColor }]}>
            {statusMessage}
          </Text>
          <Text style={styles.guidanceSub}>{subMessage}</Text>
        </View>

        {/* Circular OPay-style Camera Portal */}
        <View style={styles.portalWrapper}>
          {!permission?.granted ? (
            <View style={styles.permissionBox}>
              <Ionicons name="camera-outline" size={44} color="#2d81ff" />
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
                <CameraView
                  ref={cameraRef}
                  style={styles.camera}
                  facing="front"
                />

                {/* Dotted Face Alignment Oval */}
                {scanState !== "success" && (
                  <View style={styles.faceGuideOval} pointerEvents="none" />
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
          )}
        </View>

        {/* Bottom Controls */}
        <View style={styles.bottomActions}>
          {permission?.granted && (
            <TouchableOpacity
              style={[
                styles.scanBtn,
                scanState === "analyzing" && styles.scanBtnDisabled,
                scanState === "success" && { backgroundColor: "#10b981" },
              ]}
              onPress={handleCaptureAndVerify}
              disabled={scanState === "analyzing" || scanState === "success"}
              activeOpacity={0.85}
            >
              {scanState === "analyzing" ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Ionicons
                  name={scanState === "success" ? "checkmark-circle" : "scan-outline"}
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
          )}

          {onFallbackBiometric && scanState !== "success" && (
            <TouchableOpacity
              style={styles.fallbackBtn}
              onPress={onFallbackBiometric}
              disabled={scanState === "analyzing"}
              activeOpacity={0.75}
            >
              <Ionicons name="finger-print-outline" size={16} color="#93c5fd" />
              <Text style={styles.fallbackBtnText}>Use Device Biometric / PIN Instead</Text>
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
    backgroundColor: "#0b1629",
    paddingTop: Platform.OS === "ios" ? 56 : 32,
    paddingBottom: Platform.OS === "ios" ? 36 : 24,
    paddingHorizontal: 20,
    justifyContent: "space-between",
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topTag: {
    fontSize: 10,
    fontWeight: "700",
    color: "#60a5fa",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    letterSpacing: 0.8,
  },
  topTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#ffffff",
    marginTop: 2,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  guidanceBox: {
    backgroundColor: "rgba(20, 39, 72, 0.85)",
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    alignItems: "center",
  },
  guidanceTitle: {
    fontSize: 15,
    fontWeight: "800",
    textAlign: "center",
  },
  guidanceSub: {
    fontSize: 12.5,
    color: "#cbd5e1",
    textAlign: "center",
    marginTop: 4,
  },
  portalWrapper: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  outerRing: {
    width: 264,
    height: 264,
    borderRadius: 132,
    borderWidth: 4,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#142748",
    shadowColor: "#2d81ff",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
    elevation: 10,
  },
  circleMask: {
    width: 248,
    height: 248,
    borderRadius: 124,
    overflow: "hidden",
    position: "relative",
    backgroundColor: "#000000",
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
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: "rgba(255, 255, 255, 0.55)",
  },
  laserLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: "#2d81ff",
    shadowColor: "#60a5fa",
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
    backgroundColor: "rgba(16, 185, 129, 0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  successCheckCircle: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: "#10b981",
    alignItems: "center",
    justifyContent: "center",
  },
  permissionBox: {
    backgroundColor: "#142748",
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2d81ff",
    gap: 10,
  },
  permissionTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  permissionSub: {
    color: "#cbd5e1",
    fontSize: 13,
    textAlign: "center",
    lineHeight: 19,
  },
  permissionBtn: {
    marginTop: 8,
    backgroundColor: "#2d81ff",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 10,
  },
  permissionBtnText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.6,
  },
  bottomActions: {
    gap: 12,
  },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    backgroundColor: "#2d81ff",
    paddingVertical: 16,
    borderRadius: 14,
  },
  scanBtnDisabled: {
    backgroundColor: "#1e3a8a",
    opacity: 0.85,
  },
  scanBtnText: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.6,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  fallbackBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
  },
  fallbackBtnText: {
    color: "#93c5fd",
    fontSize: 12.5,
    fontWeight: "600",
  },
});
