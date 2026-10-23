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
} from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Ionicons } from "@expo/vector-icons";
import {
  compareFaceEmbeddings,
  FACE_MATCH_THRESHOLD,
  extractEmbeddingFromBase64,
} from "../services/faceRecognitionService";
import {
  FaceBiometricEngine,
  FaceBiometricEngineRef,
} from "./FaceBiometricEngine";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const OVAL_WIDTH = Math.min(SCREEN_WIDTH * 0.72, 280);
const OVAL_HEIGHT = OVAL_WIDTH * 1.35;

export type FaceScanStep =
  | "ALIGN"
  | "SCANNING"
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
  const [guidanceTip, setGuidanceTip] = useState<string>(
    mode === "ENROLL" ? "Position face inside oval" : "Center face to sign in",
  );
  const [guidanceSubtip, setGuidanceSubtip] = useState<string>(
    "Look directly into the camera at eye level",
  );
  const [matchScore, setMatchScore] = useState<number | null>(null);
  const [failureReason, setFailureReason] = useState<string>("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);

  // Animated laser scanline & pulse
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const enrollProgressAnim = useRef(new Animated.Value(0)).current;

  // Track attempts
  const attemptCountRef = useRef(0);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Animations
  useEffect(() => {
    if (!visible) return;

    const scanAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineAnim, {
          toValue: 1,
          duration: 1400,
          useNativeDriver: true,
        }),
        Animated.timing(scanLineAnim, {
          toValue: 0,
          duration: 1400,
          useNativeDriver: true,
        }),
      ]),
    );

    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.04,
          duration: 700,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 700,
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
      setGuidanceTip(
        mode === "ENROLL"
          ? "Position face inside oval"
          : "Looking for face...",
      );
      setGuidanceSubtip("Hold phone at eye level • Fit head inside oval");
      setMatchScore(null);
      setFailureReason("");
      setIsProcessing(false);
      setCameraReady(false);
      attemptCountRef.current = 0;
      enrollProgressAnim.setValue(0);
    }
  }, [visible, mode, enrollProgressAnim]);

  // Execute verification as fast as possible (< 350ms)
  const executeScan = useCallback(
    async (isManualTrigger = false) => {
      if (!cameraRef.current || isProcessing) return;
      setIsProcessing(true);
      setStep("SCANNING");
      setGuidanceTip("Scanning facial biometrics...");
      setGuidanceSubtip("Analyzing facial geometry in real-time");

      attemptCountRef.current += 1;

      try {
        // Fast optimized capture (low quality = tiny payload = <40ms processing)
        const photo = await cameraRef.current.takePictureAsync({
          base64: true,
          quality: mode === "ENROLL" ? 0.35 : 0.2,
          skipProcessing: true,
          shutterSound: false,
        });

        if (!photo?.base64) {
          throw new Error("Camera could not capture frame.");
        }

        // Fast on-device vector extraction
        let vector: number[];
        if (engineRef.current) {
          try {
            const res = await engineRef.current.processFrame(photo.base64);
            vector = res.vector;
          } catch {
            vector = extractEmbeddingFromBase64(photo.base64);
          }
        } else {
          vector = extractEmbeddingFromBase64(photo.base64);
        }

        // --- ENROLL MODE ---
        if (mode === "ENROLL") {
          // Animate progress to 100%
          Animated.timing(enrollProgressAnim, {
            toValue: 1,
            duration: 600,
            useNativeDriver: false,
          }).start();

          setStep("SUCCESS");
          setGuidanceTip("Facial Identity Bound!");
          setGuidanceSubtip("Account successfully locked to your biometric face profile");
          Vibration.vibrate([0, 60, 40, 60]);

          const thumbnail = `data:image/jpeg;base64,${photo.base64}`;
          setTimeout(() => {
            if (isMountedRef.current) {
              onSuccess({
                embedding: vector,
                confidence: 1.0,
                thumbnailBase64: thumbnail,
              });
            }
          }, 650);
          return;
        }

        // --- VERIFY MODE (LIGHTNING SPEED ON CLOCK-IN) ---
        if (!enrolledEmbedding || enrolledEmbedding.length === 0) {
          setStep("REJECTED");
          setFailureReason("No biometric profile enrolled on this account.");
          setGuidanceTip("Biometric Profile Missing");
          setGuidanceSubtip("Please enroll your face first to clock in.");
          Vibration.vibrate(200);
          setIsProcessing(false);
          return;
        }

        const match = compareFaceEmbeddings(vector, enrolledEmbedding);
        setMatchScore(match.confidencePercent);

        if (match.isMatch) {
          // BLAZING FAST SUCCESS!
          setStep("SUCCESS");
          setGuidanceTip(`Face Verified! (${match.confidencePercent}% Match)`);
          setGuidanceSubtip(`Confirmed identity for ${memberName || "member"}`);
          Vibration.vibrate(50); // Crisp subtle haptic tap

          // Auto-close in just 220ms for instant snappy feeling
          setTimeout(() => {
            if (isMountedRef.current) {
              onSuccess({
                embedding: vector,
                confidence: match.similarity,
              });
            }
          }, 220);
        } else {
          // If first automatic attempt failed, user might be aligning phone
          if (attemptCountRef.current === 1 && !isManualTrigger) {
            setStep("ALIGN");
            setGuidanceTip("Adjust Face: Center in Oval");
            setGuidanceSubtip("Look squarely into the oval reticle at eye level");
            setIsProcessing(false);

            // Auto retry in 450ms once user positions face
            setTimeout(() => {
              if (isMountedRef.current && visible) {
                executeScan(false);
              }
            }, 450);
            return;
          }

          // Strict Rejection (Proxy clock-in or wrong face)
          setStep("REJECTED");
          setFailureReason(
            `Face Mismatch (${match.confidencePercent}% vs ${FACE_MATCH_THRESHOLD * 100}% required). Proxy clock-in blocked.`,
          );
          setGuidanceTip("Proxy Attempt Blocked");
          setGuidanceSubtip(
            `The live face does not match the enrolled biometrics for ${memberName || "this account"}.`,
          );
          Vibration.vibrate(250);

          if (onFailure) {
            onFailure(
              `Face Mismatch (${match.confidencePercent}% match). Attendance rejected.`,
            );
          }
        }
      } catch (err: any) {
        console.warn("Fast scan error:", err);
        setStep("ERROR");
        setFailureReason(err?.message || "Failed to process face scan.");
        setGuidanceTip("Scan Interrupted");
        setGuidanceSubtip("Position your face in the oval and tap 'Scan Again'.");
      } finally {
        setIsProcessing(false);
      }
    },
    [
      mode,
      enrolledEmbedding,
      memberName,
      onSuccess,
      onFailure,
      isProcessing,
      visible,
      enrollProgressAnim,
    ],
  );

  // When camera hardware is ready: trigger fast scan immediately!
  const handleCameraReady = useCallback(() => {
    setCameraReady(true);
    // Instant scan trigger: small 120ms buffer for camera lens exposure stabilization
    const timer = setTimeout(() => {
      if (isMountedRef.current && visible) {
        executeScan(false);
      }
    }, 120);

    return () => clearTimeout(timer);
  }, [executeScan, visible]);

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
      case "SCANNING":
        return "#38BDF8"; // Electric cyan
      default:
        return "rgba(255, 255, 255, 0.7)";
    }
  };

  const getGuidanceBadgeStyle = () => {
    switch (step) {
      case "SUCCESS":
        return styles.badgeSuccess;
      case "REJECTED":
      case "ERROR":
        return styles.badgeDanger;
      case "SCANNING":
        return styles.badgeScanning;
      default:
        return styles.badgeNormal;
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
            <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
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
              onCameraReady={handleCameraReady}
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
                    {mode === "ENROLL" ? "INITIAL BINDING" : "LIVE FACE CHECK"}
                  </Text>
                  <Text style={styles.headerTitle}>
                    {mode === "ENROLL" ? "Face ID Enrollment" : "Fast Face Sign-In"}
                  </Text>
                </View>

                <View style={{ width: 38 }} />
              </View>

              {/* Real-Time Interactive Guidance Banner (Above Oval) */}
              <View style={styles.guidanceBannerWrapper}>
                <View style={[styles.guidanceBadge, getGuidanceBadgeStyle()]}>
                  <Ionicons
                    name={
                      step === "SUCCESS"
                        ? "checkmark-circle"
                        : step === "REJECTED"
                          ? "alert-circle"
                          : step === "SCANNING"
                            ? "flash"
                            : "scan-outline"
                    }
                    size={16}
                    color="#FFFFFF"
                  />
                  <Text style={styles.guidanceBadgeText}>{guidanceTip}</Text>
                </View>
                <Text style={styles.guidanceSubtext}>{guidanceSubtip}</Text>
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
                  {(step === "ALIGN" || step === "SCANNING") && (
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

                  {/* Face Guide Silhouette Dotted Outline */}
                  {step === "ALIGN" && (
                    <View style={styles.faceGuidePlaceholder} pointerEvents="none">
                      <Ionicons
                        name="person-outline"
                        size={OVAL_WIDTH * 0.65}
                        color="rgba(255, 255, 255, 0.22)"
                      />
                    </View>
                  )}

                  {/* Status Overlay inside Oval */}
                  {step === "SCANNING" && (
                    <View style={styles.innerStatusBackdrop}>
                      <ActivityIndicator size="large" color="#38BDF8" />
                      <Text style={styles.innerStatusText}>Matching...</Text>
                    </View>
                  )}

                  {step === "SUCCESS" && (
                    <View style={styles.innerStatusBackdrop}>
                      <Ionicons name="checkmark-circle" size={68} color="#10B981" />
                      <Text style={styles.innerSuccessText}>
                        {mode === "ENROLL" ? "BOUND ✓" : "MATCHED ✓"}
                      </Text>
                    </View>
                  )}

                  {step === "REJECTED" && (
                    <View style={styles.innerStatusBackdrop}>
                      <Ionicons name="close-circle" size={68} color="#EF4444" />
                      <Text style={styles.innerRejectText}>MISMATCH</Text>
                    </View>
                  )}
                </Animated.View>
              </View>

              {/* Bottom Instructions & Action Area */}
              <View style={styles.bottomArea}>
                {/* Visual Positioning Guide Checklist */}
                <View style={styles.checklistCard}>
                  <View style={styles.checkItem}>
                    <Ionicons
                      name={step === "SUCCESS" ? "checkmark-circle" : "radio-button-on"}
                      size={13}
                      color={step === "SUCCESS" ? "#10B981" : "#38BDF8"}
                    />
                    <Text style={styles.checkText}>Fit face inside oval reticle</Text>
                  </View>
                  <View style={styles.checkItem}>
                    <Ionicons
                      name={step === "SUCCESS" ? "checkmark-circle" : "radio-button-on"}
                      size={13}
                      color={step === "SUCCESS" ? "#10B981" : "#38BDF8"}
                    />
                    <Text style={styles.checkText}>Hold phone upright at eye level</Text>
                  </View>
                  <View style={styles.checkItem}>
                    <Ionicons
                      name={step === "SUCCESS" ? "checkmark-circle" : "radio-button-on"}
                      size={13}
                      color={step === "SUCCESS" ? "#10B981" : "#38BDF8"}
                    />
                    <Text style={styles.checkText}>Ensure lighting is on your face</Text>
                  </View>

                  {matchScore !== null && (
                    <View style={styles.scoreRow}>
                      <Text style={styles.scoreText}>
                        Biometric Confidence: {matchScore}% (Required: ≥{FACE_MATCH_THRESHOLD * 100}%)
                      </Text>
                    </View>
                  )}

                  {failureReason ? (
                    <Text style={styles.failureDesc}>{failureReason}</Text>
                  ) : null}
                </View>

                {/* Action Buttons */}
                <View style={styles.actionBtnRow}>
                  {step === "REJECTED" || step === "ERROR" ? (
                    <TouchableOpacity
                      style={styles.retryBtn}
                      onPress={() => executeScan(true)}
                      disabled={isProcessing}
                    >
                      <Ionicons name="refresh" size={18} color="#FFFFFF" />
                      <Text style={styles.retryBtnText}>Reposition & Scan Again</Text>
                    </TouchableOpacity>
                  ) : (
                    <TouchableOpacity
                      style={[
                        styles.captureBtn,
                        isProcessing && styles.captureBtnDisabled,
                        step === "SUCCESS" && styles.captureBtnSuccess,
                      ]}
                      onPress={() => executeScan(true)}
                      disabled={isProcessing || step === "SUCCESS"}
                    >
                      {step === "SUCCESS" ? (
                        <>
                          <Ionicons name="checkmark-circle" size={18} color="#FFFFFF" />
                          <Text style={styles.captureBtnText}>Verified! Redirecting...</Text>
                        </>
                      ) : isProcessing ? (
                        <ActivityIndicator color="#FFFFFF" size="small" />
                      ) : (
                        <>
                          <Ionicons name="scan-outline" size={18} color="#FFFFFF" />
                          <Text style={styles.captureBtnText}>
                            {mode === "ENROLL" ? "Capture & Bind Face" : "Scan Face Now"}
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
    color: "#38BDF8",
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
  guidanceBannerWrapper: {
    alignItems: "center",
    paddingHorizontal: 24,
    gap: 6,
  },
  guidanceBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
  },
  badgeNormal: {
    backgroundColor: "rgba(15, 23, 42, 0.85)",
    borderWidth: 1,
    borderColor: "rgba(56, 189, 248, 0.4)",
  },
  badgeScanning: {
    backgroundColor: "rgba(2, 132, 199, 0.9)",
  },
  badgeSuccess: {
    backgroundColor: "#059669",
  },
  badgeDanger: {
    backgroundColor: "#DC2626",
  },
  guidanceBadgeText: {
    color: "#FFFFFF",
    fontSize: 13,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  guidanceSubtext: {
    color: "#CBD5E1",
    fontSize: 12,
    textAlign: "center",
    lineHeight: 16,
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
  faceGuidePlaceholder: {
    position: "absolute",
    alignItems: "center",
    justifyContent: "center",
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
    gap: 12,
  },
  checklistCard: {
    backgroundColor: "rgba(15, 23, 42, 0.85)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  checkItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkText: {
    fontSize: 11,
    color: "#94A3B8",
    fontWeight: "500",
  },
  scoreRow: {
    marginTop: 4,
    paddingTop: 6,
    borderTopWidth: 1,
    borderTopColor: "rgba(255, 255, 255, 0.1)",
  },
  scoreText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#38BDF8",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    textAlign: "center",
  },
  failureDesc: {
    fontSize: 11,
    color: "#FCA5A5",
    textAlign: "center",
    lineHeight: 16,
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
  captureBtnSuccess: {
    backgroundColor: "#059669",
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
