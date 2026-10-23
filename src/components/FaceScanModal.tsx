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

// Safe dynamic initialization of Google ML Kit Native Module
let mlkitDetector: any = null;
try {
  const { RNMLKitFaceDetector } = require("@infinitered/react-native-mlkit-face-detection");
  mlkitDetector = new RNMLKitFaceDetector({ performanceMode: "fast" });
} catch {
  // Falls back to Canvas engine if native binary is not yet compiled
}

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const OVAL_WIDTH = Math.min(SCREEN_WIDTH * 0.74, 280);
const OVAL_HEIGHT = OVAL_WIDTH * 1.34;

export type FaceScanStep =
  | "SEARCHING"   // Looking for face
  | "OFF_CENTER"  // Face present but shifted
  | "TRACKING"    // Face centered, filling progress
  | "SUCCESS"     // 100% captured / verified
  | "MISMATCH";   // Only in verify mode when wrong face

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

  const [step, setStep] = useState<FaceScanStep>("SEARCHING");
  const [guidanceTip, setGuidanceTip] = useState<string>("Position face in oval");
  const [guidanceSubtip, setGuidanceSubtip] = useState<string>(
    "Hold phone upright at eye level"
  );
  const [progressPercent, setProgressPercent] = useState<number>(0);
  const [matchScore, setMatchScore] = useState<number | null>(null);

  // Animations
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Active loop refs
  const isScanningRef = useRef(false);
  const loopActiveRef = useRef(false);
  const consecutiveCenteredFramesRef = useRef(0);
  const bestVectorRef = useRef<number[] | null>(null);
  const bestThumbnailRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  const scanTimerRef = useRef<any>(null);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      loopActiveRef.current = false;
    };
  }, []);

  // Animations
  useEffect(() => {
    if (!visible) return;

    const scanAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineAnim, {
          toValue: 1,
          duration: 1300,
          useNativeDriver: true,
        }),
        Animated.timing(scanLineAnim, {
          toValue: 0,
          duration: 1300,
          useNativeDriver: true,
        }),
      ])
    );

    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.03,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1.0,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
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
      setStep("SEARCHING");
      setGuidanceTip("Position face in oval");
      setGuidanceSubtip("Hold phone upright at eye level");
      setProgressPercent(0);
      setMatchScore(null);
      isScanningRef.current = false;
      loopActiveRef.current = true;
      consecutiveCenteredFramesRef.current = 0;
      bestVectorRef.current = null;
      bestThumbnailRef.current = null;
      progressAnim.setValue(0);
    } else {
      loopActiveRef.current = false;
    }
  }, [visible, progressAnim]);

  // Auto-scanning loop (Like OPay / Apple Face ID: Zero buttons, hands-free)
  const processNextFrame = useCallback(async () => {
    if (
      !loopActiveRef.current ||
      !cameraRef.current ||
      isScanningRef.current ||
      !visible
    ) {
      return;
    }

    isScanningRef.current = true;

    try {
      const photo = await cameraRef.current.takePictureAsync({
        base64: true,
        quality: 0.18,
        skipProcessing: true,
        shutterSound: false,
      });

      if (!photo?.base64 || !loopActiveRef.current) {
        isScanningRef.current = false;
        return;
      }

      let hasFace = false;
      let isCentered = false;
      let guidance = "NO_FACE";
      let vector: number[] = [];

      // 1. Primary AI Engine: Google ML Kit (Native On-Device)
      if (mlkitDetector && photo?.uri) {
        try {
          const mlkitRes = await mlkitDetector.detectFaces(photo.uri);
          if (mlkitRes && Array.isArray(mlkitRes.faces)) {
            if (mlkitRes.faces.length > 0) {
              hasFace = true;
              const primaryFace = mlkitRes.faces[0];
              const yaw = primaryFace.headEulerAngleY || 0;
              if (yaw > 16) {
                isCentered = false;
                guidance = "MOVE_LEFT";
              } else if (yaw < -16) {
                isCentered = false;
                guidance = "MOVE_RIGHT";
              } else {
                isCentered = true;
                guidance = "CENTERED";
              }
            }
          }
        } catch {}
      }

      // 2. Secondary Engine: HTML5 Canvas Edge Gradients
      if (!hasFace && engineRef.current && photo?.base64) {
        try {
          const engineRes = await engineRef.current.processFrame(photo.base64);
          hasFace = Boolean(engineRes.hasFace);
          isCentered = Boolean(engineRes.isCentered);
          guidance = engineRes.guidance || "NO_FACE";
          vector = engineRes.vector || [];
        } catch {}
      }

      // 3. Extract 128-D biometric vector for Firestore attendance comparison
      if (hasFace && (!vector || vector.length === 0)) {
        vector = extractEmbeddingFromBase64(photo.base64);
      }

      if (!hasFace) {
        // No face in frame
        consecutiveCenteredFramesRef.current = Math.max(
          0,
          consecutiveCenteredFramesRef.current - 1
        );
        const newPct = Math.max(0, consecutiveCenteredFramesRef.current * 33);
        setProgressPercent(newPct);

        setStep("SEARCHING");
        setGuidanceTip("Position face in oval");
        setGuidanceSubtip("Fit your head completely inside the circle");
      } else if (!isCentered) {
        // Face present but off-center
        setStep("OFF_CENTER");
        if (guidance === "MOVE_LEFT") {
          setGuidanceTip("Move slightly left");
        } else if (guidance === "MOVE_RIGHT") {
          setGuidanceTip("Move slightly right");
        } else {
          setGuidanceTip("Center face in oval");
        }
        setGuidanceSubtip("Align your face in the center of the reticle");
      } else {
        // Face is perfectly centered inside the oval reticle!
        setStep("TRACKING");
        consecutiveCenteredFramesRef.current += 1;
        bestVectorRef.current = vector;
        bestThumbnailRef.current = `data:image/jpeg;base64,${photo.base64}`;

        const frames = consecutiveCenteredFramesRef.current;
        const newPct = Math.min(100, frames * 34);
        setProgressPercent(newPct);

        Animated.timing(progressAnim, {
          toValue: newPct / 100,
          duration: 250,
          useNativeDriver: false,
        }).start();

        // Subtle haptic tick for feedback
        Vibration.vibrate(20);

        setGuidanceTip("Face Detected • Hold Still...");
        setGuidanceSubtip(`Analyzing facial biometrics... ${Math.round(newPct)}%`);

        // Check for 100% completion (3 consecutive centered frames = ~1.2s of holding still)
        if (frames >= 3) {
          loopActiveRef.current = false; // Stop loop

          if (mode === "ENROLL") {
            // ENROLLMENT SUCCESS!
            setStep("SUCCESS");
            setGuidanceTip("Face ID Profile Bound! ✓");
            setGuidanceSubtip(
              "Account successfully secured with your facial biometric profile"
            );
            Vibration.vibrate([0, 50, 40, 50]);

            const finalVector = bestVectorRef.current || vector;
            const finalThumb = bestThumbnailRef.current;

            setTimeout(() => {
              if (isMountedRef.current) {
                onSuccess({
                  embedding: finalVector,
                  confidence: 1.0,
                  thumbnailBase64: finalThumb || undefined,
                });
              }
            }, 600);
            return;
          } else {
            // VERIFY MODE
            if (!enrolledEmbedding || enrolledEmbedding.length === 0) {
              setStep("MISMATCH");
              setGuidanceTip("Biometric Profile Missing");
              setGuidanceSubtip("Please enroll your face first to clock in.");
              Vibration.vibrate(200);
              return;
            }

            const match = compareFaceEmbeddings(vector, enrolledEmbedding);
            setMatchScore(match.confidencePercent);

            if (match.isMatch) {
              // VERIFY SUCCESS!
              setStep("SUCCESS");
              setGuidanceTip(
                `Face Verified! (${match.confidencePercent}% Match) ✓`
              );
              setGuidanceSubtip(
                `Confirmed identity for ${memberName || "member"}`
              );
              Vibration.vibrate(40);

              setTimeout(() => {
                if (isMountedRef.current) {
                  onSuccess({
                    embedding: vector,
                    confidence: match.similarity,
                  });
                }
              }, 400);
              return;
            } else {
              // Actual mismatch during verification (Wrong person)
              setStep("MISMATCH");
              setGuidanceTip(`Face Mismatch (${match.confidencePercent}%)`);
              setGuidanceSubtip(
                `Does not match enrolled biometrics for ${memberName || "this account"}.`
              );
              Vibration.vibrate(250);

              if (onFailure) {
                onFailure(
                  `Face mismatch (${match.confidencePercent}% confidence). Proxy attendance blocked.`
                );
              }

              // Auto-resume scan after 2 seconds so user can try again
              setTimeout(() => {
                if (isMountedRef.current && visible) {
                  consecutiveCenteredFramesRef.current = 0;
                  loopActiveRef.current = true;
                  setStep("SEARCHING");
                  setMatchScore(null);
                }
              }, 2000);
              return;
            }
          }
        }
      }
    } catch (err) {
      console.warn("Scan frame capture error:", err);
    } finally {
      isScanningRef.current = false;
      if (loopActiveRef.current && isMountedRef.current && visible) {
        scanTimerRef.current = setTimeout(() => {
          if (loopActiveRef.current && isMountedRef.current && visible) {
            processNextFrame();
          }
        }, 320);
      }
    }
  }, [
    visible,
    mode,
    enrolledEmbedding,
    memberName,
    onSuccess,
    onFailure,
    progressAnim,
  ]);

  // Main continuous auto-scan loop trigger
  useEffect(() => {
    if (!visible || !permission?.granted) return;

    loopActiveRef.current = true;
    scanTimerRef.current = setTimeout(() => {
      if (loopActiveRef.current && isMountedRef.current && visible) {
        processNextFrame();
      }
    }, 450);

    return () => {
      loopActiveRef.current = false;
      if (scanTimerRef.current) {
        clearTimeout(scanTimerRef.current);
      }
    };
  }, [visible, permission?.granted, processNextFrame]);

  if (!visible) return null;

  const translateY = scanLineAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, OVAL_HEIGHT - 6],
  });

  const getBorderColor = () => {
    switch (step) {
      case "SUCCESS":
        return "#10B981"; // Emerald green
      case "MISMATCH":
        return "#EF4444"; // Red
      case "TRACKING":
        return "#0EA5E9"; // Cyan
      case "OFF_CENTER":
        return "#F59E0B"; // Amber
      default:
        return "rgba(255, 255, 255, 0.5)";
    }
  };

  const getGuidanceBadgeStyle = () => {
    switch (step) {
      case "SUCCESS":
        return styles.badgeSuccess;
      case "MISMATCH":
        return styles.badgeDanger;
      case "TRACKING":
        return styles.badgeTracking;
      case "OFF_CENTER":
        return styles.badgeWarning;
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

        {/* Camera Permission Gate */}
        {!permission?.granted ? (
          <View style={styles.permContainer}>
            <Ionicons name="camera-outline" size={56} color="#94A3B8" />
            <Text style={styles.permTitle}>Camera Permission Required</Text>
            <Text style={styles.permDesc}>
              Presenti needs front camera access to calibrate your Apple Face
              ID-style biometric identity.
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
            />

            {/* Apple Face ID Translucent Vignette Mask */}
            <View style={styles.overlay}>
              {/* Header Bar */}
              <View style={styles.topBar}>
                <TouchableOpacity
                  style={styles.cancelRoundBtn}
                  onPress={onClose}
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                >
                  <Ionicons name="close" size={20} color="#FFFFFF" />
                </TouchableOpacity>

                <View style={styles.headerInfo}>
                  <Text style={styles.headerBadge}>
                    {mode === "ENROLL" ? "INITIAL BINDING" : "ATTENDANCE VERIFICATION"}
                  </Text>
                  <Text style={styles.headerTitle}>
                    {mode === "ENROLL" ? "Face ID Enrollment" : "Biometric Sign-In"}
                  </Text>
                </View>

                <View style={{ width: 38 }} />
              </View>

              {/* Dynamic Guidance Pill (Top Banner) */}
              <View style={styles.guidanceBannerWrapper}>
                <View style={[styles.guidanceBadge, getGuidanceBadgeStyle()]}>
                  <Ionicons
                    name={
                      step === "SUCCESS"
                        ? "checkmark-circle"
                        : step === "MISMATCH"
                        ? "alert-circle"
                        : step === "TRACKING"
                        ? "scan"
                        : step === "OFF_CENTER"
                        ? "hand-right-outline"
                        : "person-outline"
                    }
                    size={16}
                    color="#FFFFFF"
                  />
                  <Text style={styles.guidanceBadgeText}>{guidanceTip}</Text>
                </View>
                <Text style={styles.guidanceSubtext}>{guidanceSubtip}</Text>
              </View>

              {/* Centered Apple Face ID Oval Reticle */}
              <View style={styles.centerArea}>
                <Animated.View
                  style={[
                    styles.ovalContainer,
                    {
                      borderColor: getBorderColor(),
                      transform: [
                        {
                          scale: step === "TRACKING" ? pulseAnim : 1.0,
                        },
                      ],
                    },
                  ]}
                >
                  {/* Scanning Laser Line (Active during tracking & searching) */}
                  {(step === "SEARCHING" || step === "TRACKING" || step === "OFF_CENTER") && (
                    <Animated.View
                      style={[
                        styles.scanLine,
                        {
                          transform: [{ translateY }],
                          backgroundColor:
                            step === "TRACKING" ? "#38BDF8" : "rgba(255, 255, 255, 0.4)",
                        },
                      ]}
                    />
                  )}

                  {/* Corner Accent Ticks (Apple Face ID HUD) */}
                  <View style={[styles.cornerAcc, styles.cTopLeft, { borderColor: getBorderColor() }]} />
                  <View style={[styles.cornerAcc, styles.cTopRight, { borderColor: getBorderColor() }]} />
                  <View style={[styles.cornerAcc, styles.cBottomLeft, { borderColor: getBorderColor() }]} />
                  <View style={[styles.cornerAcc, styles.cBottomRight, { borderColor: getBorderColor() }]} />

                  {/* Face Guide Silhouette Placeholder */}
                  {step === "SEARCHING" && (
                    <View style={styles.faceGuidePlaceholder} pointerEvents="none">
                      <Ionicons
                        name="person-outline"
                        size={OVAL_WIDTH * 0.65}
                        color="rgba(255, 255, 255, 0.25)"
                      />
                    </View>
                  )}

                  {/* Success State Overlay */}
                  {step === "SUCCESS" && (
                    <View style={styles.innerStatusBackdrop}>
                      <Ionicons name="checkmark-circle" size={76} color="#10B981" />
                      <Text style={styles.innerSuccessText}>
                        {mode === "ENROLL" ? "BOUND ✓" : "MATCHED ✓"}
                      </Text>
                    </View>
                  )}

                  {/* Mismatch Overlay (ONLY in VERIFY mode when wrong person clocks in) */}
                  {step === "MISMATCH" && (
                    <View style={styles.innerStatusBackdrop}>
                      <Ionicons name="close-circle" size={72} color="#EF4444" />
                      <Text style={styles.innerRejectText}>MISMATCH</Text>
                    </View>
                  )}
                </Animated.View>

                {/* Progress Bar under Oval */}
                <View style={styles.progressBarWrapper}>
                  <View style={styles.progressBarBg}>
                    <Animated.View
                      style={[
                        styles.progressBarFill,
                        {
                          width: progressAnim.interpolate({
                            inputRange: [0, 1],
                            outputRange: ["0%", "100%"],
                          }),
                          backgroundColor:
                            step === "SUCCESS" ? "#10B981" : "#38BDF8",
                        },
                      ]}
                    />
                  </View>
                  <Text style={styles.progressPercentText}>
                    {step === "SUCCESS"
                      ? "100% COMPLETE"
                      : `${Math.round(progressPercent)}%`}
                  </Text>
                </View>
              </View>

              {/* Bottom Instructions Card */}
              <View style={styles.bottomArea}>
                <View style={styles.checklistCard}>
                  <View style={styles.checkItem}>
                    <Ionicons
                      name={
                        step === "TRACKING" || step === "SUCCESS"
                          ? "checkmark-circle"
                          : "radio-button-on"
                      }
                      size={14}
                      color={
                        step === "TRACKING" || step === "SUCCESS"
                          ? "#10B981"
                          : "#38BDF8"
                      }
                    />
                    <Text style={styles.checkText}>Face centered inside circle</Text>
                  </View>
                  <View style={styles.checkItem}>
                    <Ionicons
                      name={
                        step !== "OFF_CENTER"
                          ? "checkmark-circle"
                          : "radio-button-on"
                      }
                      size={14}
                      color={step !== "OFF_CENTER" ? "#10B981" : "#38BDF8"}
                    />
                    <Text style={styles.checkText}>Phone upright at eye level</Text>
                  </View>
                  <View style={styles.checkItem}>
                    <Ionicons
                      name={step === "SUCCESS" ? "checkmark-circle" : "radio-button-on"}
                      size={14}
                      color={step === "SUCCESS" ? "#10B981" : "#38BDF8"}
                    />
                    <Text style={styles.checkText}>Even lighting across face</Text>
                  </View>

                  {matchScore !== null && (
                    <View style={styles.scoreRow}>
                      <Text style={styles.scoreText}>
                        Biometric Confidence: {matchScore}% (Required: ≥
                        {FACE_MATCH_THRESHOLD * 100}%)
                      </Text>
                    </View>
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
    backgroundColor: "rgba(11, 15, 25, 0.48)",
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
  badgeTracking: {
    backgroundColor: "rgba(2, 132, 199, 0.95)",
  },
  badgeWarning: {
    backgroundColor: "rgba(217, 119, 6, 0.95)",
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
    gap: 16,
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
    backgroundColor: "rgba(11, 15, 25, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
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
  progressBarWrapper: {
    width: OVAL_WIDTH * 0.85,
    alignItems: "center",
    gap: 6,
  },
  progressBarBg: {
    width: "100%",
    height: 6,
    backgroundColor: "rgba(255, 255, 255, 0.15)",
    borderRadius: 3,
    overflow: "hidden",
  },
  progressBarFill: {
    height: "100%",
    borderRadius: 3,
  },
  progressPercentText: {
    fontSize: 11,
    fontWeight: "700",
    color: "#38BDF8",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    letterSpacing: 0.5,
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
    gap: 8,
  },
  checkItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  checkText: {
    fontSize: 12,
    color: "#CBD5E1",
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
