import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Animated,
  Dimensions,
  Platform,
  Vibration,
  Image,
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import {
  compareFaceEmbeddings,
  verifyLivenessDelta,
  FACE_MATCH_THRESHOLD,
  extractEmbeddingFromBase64,
} from "../services/faceRecognitionService";
import {
  FaceBiometricEngine,
  FaceBiometricEngineRef,
} from "./FaceBiometricEngine";

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get("window");
const OVAL_WIDTH = Math.min(SCREEN_WIDTH * 0.72, 280);
const OVAL_HEIGHT = OVAL_WIDTH * 1.35;

export type FaceScanStep =
  | "ALIGN"
  | "HOLD_STEADY"
  | "ANALYZING"
  | "SUCCESS"
  | "REJECTED"
  | "ERROR";

export interface FaceScanModalProps {
  visible: boolean;
  mode: "ENROLL" | "VERIFY";
  memberName?: string;
  enrolledEmbedding?: number[];
  onSuccess: (result: {
    embedding: number[];
    confidence: number;
    thumbnailBase64?: string;
  }) => void;
  onFailure?: (reason: string) => void;
  onClose: () => void;
}

export const FaceScanModal: React.FC<FaceScanModalProps> = ({
  visible,
  mode,
  memberName,
  enrolledEmbedding,
  onSuccess,
  onFailure,
  onClose,
}) => {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<any>(null);
  const engineRef = useRef<FaceBiometricEngineRef>(null);

  const [step, setStep] = useState<FaceScanStep>("ALIGN");
  const [statusMessage, setStatusMessage] = useState<string>(
    mode === "ENROLL" ? "Position face in oval" : "Align face to verify",
  );
  const [matchScore, setMatchScore] = useState<number | null>(null);
  const [failureReason, setFailureReason] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);

  // Animated laser scanline
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Start laser scan animation
  useEffect(() => {
    if (!visible) return;

    const scanAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineAnim, {
          toValue: 1,
          duration: 1800,
          useNativeDriver: true,
        }),
        Animated.timing(scanLineAnim, {
          toValue: 0,
          duration: 1800,
          useNativeDriver: true,
        }),
      ]),
    );

    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.05,
          duration: 900,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 900,
          useNativeDriver: true,
        }),
      ]),
    );

    scanAnimation.start();
    pulseAnimation.start();

    return () => {
      scanAnimation.stop();
      pulseAnimation.stop();
    };
  }, [visible, scanLineAnim, pulseAnim]);

  // Reset state when opening modal
  useEffect(() => {
    if (visible) {
      setStep("ALIGN");
      setStatusMessage(
        mode === "ENROLL"
          ? "Position face inside oval"
          : "Align face to clock in",
      );
      setMatchScore(null);
      setFailureReason("");
      setIsProcessing(false);

      // Auto-trigger capture after 1.2s to let camera focus and user position face
      const autoTimer = setTimeout(() => {
        handleTriggerScan();
      }, 1400);

      return () => clearTimeout(autoTimer);
    }
  }, [visible, mode]);

  const handleTriggerScan = useCallback(async () => {
    if (!cameraRef.current || isProcessing) return;
    setIsProcessing(true);
    setStep("HOLD_STEADY");
    setStatusMessage("Hold steady • Analyzing live face...");

    try {
      // 1. Capture Frame 1
      const photo1 = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.35,
        shutterSound: false,
      });

      if (!photo1?.base64) {
        throw new Error("Could not capture camera frame.");
      }

      // Small pause for 3D liveness micro-motion detection (300ms)
      await new Promise((res) => setTimeout(res, 300));

      // 2. Capture Frame 2
      const photo2 = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.35,
        shutterSound: false,
      });

      setStep("ANALYZING");
      setStatusMessage("Computing 128D biometric vector...");

      // 3. Process biometrics through engine (or pure JS fallback)
      let vector1: number[];
      let vector2: number[];

      if (engineRef.current) {
        const [res1, res2] = await Promise.all([
          engineRef.current.processFrame(photo1.base64),
          photo2?.base64
            ? engineRef.current.processFrame(photo2.base64)
            : Promise.resolve(null),
        ]);
        vector1 = res1.vector;
        vector2 = res2 ? res2.vector : vector1;
      } else {
        vector1 = extractEmbeddingFromBase64(photo1.base64);
        vector2 = photo2?.base64
          ? extractEmbeddingFromBase64(photo2.base64)
          : vector1;
      }

      // 4. Liveness & Anti-Spoofing check
      const liveness = verifyLivenessDelta(vector1, vector2);
      if (!liveness.isLive) {
        setStep("REJECTED");
        setFailureReason(liveness.reason || "Liveness check failed.");
        setStatusMessage("Liveness verification failed");
        Vibration.vibrate(200);
        setIsProcessing(false);
        return;
      }

      // 5. ENROLL MODE
      if (mode === "ENROLL") {
        setStep("SUCCESS");
        setStatusMessage("Facial Identity Bound Successfully!");
        Vibration.vibrate([0, 80, 50, 80]);

        const thumbnail = `data:image/jpeg;base64,${photo1.base64}`;
        setTimeout(() => {
          onSuccess({
            embedding: vector1,
            confidence: 1.0,
            thumbnailBase64: thumbnail,
          });
        }, 900);
        return;
      }

      // 6. VERIFY MODE
      if (!enrolledEmbedding || enrolledEmbedding.length === 0) {
        setStep("REJECTED");
        setFailureReason("No facial biometric profile found on this account.");
        setStatusMessage("Biometric profile missing");
        Vibration.vibrate(200);
        setIsProcessing(false);
        return;
      }

      const match = compareFaceEmbeddings(vector1, enrolledEmbedding);
      setMatchScore(match.confidencePercent);

      if (match.isMatch) {
        setStep("SUCCESS");
        setStatusMessage(
          `Face Verified • ${match.confidencePercent}% Confidence`,
        );
        Vibration.vibrate([0, 80, 50, 80]);

        setTimeout(() => {
          onSuccess({
            embedding: vector1,
            confidence: match.similarity,
          });
        }, 850);
      } else {
        setStep("REJECTED");
        setFailureReason(
          `Face Mismatch: Live biometric vector does not match the enrolled face for ${memberName || "this account"}. (Match score: ${match.confidencePercent}% vs ${FACE_MATCH_THRESHOLD * 100}% required).`,
        );
        setStatusMessage("Face Mismatch • Attendance Blocked");
        Vibration.vibrate(300);
        if (onFailure) {
          onFailure(
            `Face Mismatch (${match.confidencePercent}% match). Attendance rejected.`,
          );
        }
      }
    } catch (err: any) {
      console.warn("Face scan error:", err);
      setStep("ERROR");
      setFailureReason(err?.message || "Failed to process face scan.");
      setStatusMessage("Scan failed. Tap to try again.");
    } finally {
      setIsProcessing(false);
    }
  }, [mode, enrolledEmbedding, memberName, onSuccess, onFailure, isProcessing]);

  if (!visible) return null;

  const translateY = scanLineAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, OVAL_HEIGHT - 4],
  });

  const getBorderColor = () => {
    switch (step) {
      case "SUCCESS":
        return "#10B981"; // Emerald green
      case "REJECTED":
      case "ERROR":
        return "#EF4444"; // Red
      case "HOLD_STEADY":
      case "ANALYZING":
        return "#3B82F6"; // Electric blue
      default:
        return "rgba(255, 255, 255, 0.75)";
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="fade"
      transparent={false}
      onRequestClose={onClose}
    >
      <View style={styles.container}>
        {/* Headless Biometric AI Engine */}
        <FaceBiometricEngine ref={engineRef} />

        {/* Camera View */}
        {!permission?.granted ? (
          <View style={styles.permContainer}>
            <Ionicons name="camera-outline" size={56} color="#94A3B8" />
            <Text style={styles.permTitle}>Camera Permission Required</Text>
            <Text style={styles.permDesc}>
              Presenti needs front camera access to verify your facial identity
              for attendance.
            </Text>
            <TouchableOpacity
              style={styles.permBtn}
              onPress={requestPermission}
            >
              <Text style={styles.permBtnText}>Grant Camera Access</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.closeBtn} onPress={onClose}>
              <Text style={styles.closeBtnText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={StyleSheet.absoluteFill}>
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing="front"
            />

            {/* Dark Mask with Oval Cutout */}
            <View style={styles.overlay}>
              {/* Header Bar */}
              <View style={styles.topBar}>
                <TouchableOpacity
                  style={styles.cancelRoundBtn}
                  onPress={onClose}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Ionicons name="close" size={22} color="#FFFFFF" />
                </TouchableOpacity>

                <View style={styles.headerInfo}>
                  <Text style={styles.headerBadge}>
                    {mode === "ENROLL" ? "ACCOUNT BINDING" : "IDENTITY CHECK"}
                  </Text>
                  <Text style={styles.headerTitle}>
                    {mode === "ENROLL"
                      ? "Enroll Facial Identity"
                      : "Presenti FaceID"}
                  </Text>
                </View>

                <View style={{ width: 36 }} />
              </View>

              {/* Center Oval Reticle */}
              <View style={styles.centerArea}>
                <Animated.View
                  style={[
                    styles.ovalContainer,
                    {
                      borderColor: getBorderColor(),
                      transform: [{ scale: pulseAnim }],
                    },
                  ]}
                >
                  {/* Scanning Laser Beam */}
                  {(step === "ALIGN" ||
                    step === "HOLD_STEADY" ||
                    step === "ANALYZING") && (
                    <Animated.View
                      style={[
                        styles.scanLine,
                        { transform: [{ translateY }] },
                      ]}
                    />
                  )}

                  {/* Reticle HUD Accents */}
                  <View style={[styles.cornerAcc, styles.cTopLeft]} />
                  <View style={[styles.cornerAcc, styles.cTopRight]} />
                  <View style={[styles.cornerAcc, styles.cBottomLeft]} />
                  <View style={[styles.cornerAcc, styles.cBottomRight]} />

                  {/* Status Overlay inside Oval */}
                  {step === "ANALYZING" && (
                    <View style={styles.innerStatusBackdrop}>
                      <ActivityIndicator size="large" color="#3B82F6" />
                      <Text style={styles.innerStatusText}>Matching...</Text>
                    </View>
                  )}

                  {step === "SUCCESS" && (
                    <View style={styles.innerStatusBackdrop}>
                      <Ionicons
                        name="checkmark-circle"
                        size={64}
                        color="#10B981"
                      />
                      <Text style={styles.innerSuccessText}>
                        {mode === "ENROLL" ? "ENROLLED" : "VERIFIED"}
                      </Text>
                    </View>
                  )}

                  {step === "REJECTED" && (
                    <View style={styles.innerStatusBackdrop}>
                      <Ionicons name="alert-circle" size={64} color="#EF4444" />
                      <Text style={styles.innerRejectText}>MISMATCH</Text>
                    </View>
                  )}
                </Animated.View>
              </View>

              {/* Bottom Instructions & HUD */}
              <View style={styles.bottomArea}>
                <View style={styles.statusCard}>
                  <View style={styles.statusIndicatorRow}>
                    <View
                      style={[
                        styles.statusDot,
                        { backgroundColor: getBorderColor() },
                      ]}
                    />
                    <Text style={styles.statusTitle}>{statusMessage}</Text>
                  </View>

                  {matchScore !== null && (
                    <Text style={styles.scoreText}>
                      Biometric Match: {matchScore}% (Required: ≥
                      {FACE_MATCH_THRESHOLD * 100}%)
                    </Text>
                  )}

                  {failureReason ? (
                    <Text style={styles.failureDesc}>{failureReason}</Text>
                  ) : (
                    <Text style={styles.statusSubtitle}>
                      {mode === "ENROLL"
                        ? "Locks your account to your facial geometry to block buddy punching."
                        : `Confirming presence for ${memberName || "member"}. Keep head centered.`}
                    </Text>
                  )}
                </View>

                {/* Action Buttons */}
                <View style={styles.actionBtnRow}>
                  {step === "REJECTED" || step === "ERROR" ? (
                    <TouchableOpacity
                      style={styles.retryBtn}
                      onPress={handleTriggerScan}
                      disabled={isProcessing}
                    >
                      <Ionicons name="refresh" size={18} color="#FFFFFF" />
                      <Text style={styles.retryBtnText}>Scan Again</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[
                        styles.captureBtn,
                        isProcessing && styles.captureBtnDisabled,
                      ]}
                      onPress={handleTriggerScan}
                      disabled={isProcessing}
                    >
                      {isProcessing ? (
                        <ActivityIndicator color="#FFFFFF" size="small" />
                      ) : (
                        <>
                          <Ionicons
                            name="scan-outline"
                            size={18}
                            color="#FFFFFF"
                          />
                          <Text style={styles.captureBtnText}>
                            {mode === "ENROLL"
                              ? "Capture & Bind Face"
                              : "Verify Face Now"}
                          </Text>
                        </>
                      )}
                    </TouchableOpacity>
                  )}
                </View>
              </View>
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#0B0F19",
  },
  overlay: {
    flex: 1,
    backgroundColor: "rgba(11, 15, 25, 0.45)",
    justifyContent: "space-between",
    paddingTop: Platform.OS === "ios" ? 54 : 32,
    paddingBottom: Platform.OS === "ios" ? 44 : 28,
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
  },
  cancelRoundBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.15)",
  },
  headerInfo: {
    alignItems: "center",
  },
  headerBadge: {
    fontSize: 10,
    fontWeight: "800",
    color: "#60A5FA",
    letterSpacing: 1.2,
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    marginBottom: 2,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: "#FFFFFF",
    letterSpacing: -0.3,
  },
  centerArea: {
    alignItems: "center",
    justifyContent: "center",
  },
  ovalContainer: {
    width: OVAL_WIDTH,
    height: OVAL_HEIGHT,
    borderRadius: OVAL_WIDTH / 2,
    borderWidth: 3,
    position: "relative",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  scanLine: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: 3,
    backgroundColor: "#38BDF8",
    shadowColor: "#38BDF8",
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.9,
    shadowRadius: 8,
    elevation: 6,
  },
  cornerAcc: {
    position: "absolute",
    width: 16,
    height: 16,
    borderColor: "#38BDF8",
  },
  cTopLeft: {
    top: 18,
    left: 18,
    borderTopWidth: 2,
    borderLeftWidth: 2,
  },
  cTopRight: {
    top: 18,
    right: 18,
    borderTopWidth: 2,
    borderRightWidth: 2,
  },
  cBottomLeft: {
    bottom: 18,
    left: 18,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
  },
  cBottomRight: {
    bottom: 18,
    right: 18,
    borderBottomWidth: 2,
    borderRightWidth: 2,
  },
  innerStatusBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(11, 15, 25, 0.7)",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  innerStatusText: {
    color: "#38BDF8",
    fontSize: 13,
    fontWeight: "700",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    letterSpacing: 0.5,
  },
  innerSuccessText: {
    color: "#10B981",
    fontSize: 16,
    fontWeight: "800",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    letterSpacing: 1.5,
  },
  innerRejectText: {
    color: "#EF4444",
    fontSize: 16,
    fontWeight: "800",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    letterSpacing: 1.5,
  },
  bottomArea: {
    paddingHorizontal: 20,
    gap: 14,
  },
  statusCard: {
    backgroundColor: "rgba(15, 23, 42, 0.85)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 16,
    padding: 16,
    alignItems: "center",
    gap: 6,
  },
  statusIndicatorRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusTitle: {
    fontSize: 15,
    fontWeight: "700",
    color: "#FFFFFF",
  },
  statusSubtitle: {
    fontSize: 12,
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 18,
  },
  scoreText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#38BDF8",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  failureDesc: {
    fontSize: 12,
    color: "#FCA5A5",
    textAlign: "center",
    lineHeight: 18,
    marginTop: 2,
  },
  actionBtnRow: {
    flexDirection: "row",
    gap: 12,
  },
  captureBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#2563EB",
    paddingVertical: 14,
    borderRadius: 12,
  },
  captureBtnDisabled: {
    opacity: 0.65,
  },
  captureBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  retryBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#DC2626",
    paddingVertical: 14,
    borderRadius: 12,
  },
  retryBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  permContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 32,
    gap: 16,
  },
  permTitle: {
    fontSize: 20,
    fontWeight: "700",
    color: "#FFFFFF",
    textAlign: "center",
  },
  permDesc: {
    fontSize: 14,
    color: "#94A3B8",
    textAlign: "center",
    lineHeight: 22,
  },
  permBtn: {
    backgroundColor: "#2563EB",
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 8,
  },
  permBtnText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "700",
  },
  closeBtn: {
    paddingVertical: 8,
  },
  closeBtnText: {
    color: "#94A3B8",
    fontSize: 13,
  },
});
