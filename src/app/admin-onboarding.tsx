import React, { useState, useEffect, useRef } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Switch,
} from "react-native";
import { router } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { C, MONO, R, S, T, shadow, ui, rf } from "../constants/premium";
import { LocationPickerModal } from "../components/LocationPickerModal";
import { ShiftScheduleEditor } from "../components/ShiftScheduleEditor";
import {
  ALL_COUNTRIES_AZ,
  QUICK_COUNTRIES,
  getCitiesForState,
  getStatesForCountry,
} from "../data/locationsData";
import type { DaySchedule, ShiftSchedule } from "../types";

const DEFAULT_SHIFTS: ShiftSchedule[] = [
  {
    id: "MORNING",
    name: "Morning Shift",
    arrivalCutoff: "06:00",
    lateTolerance: "06:30",
    signOutTime: "14:00",
    allowLateSignIn: true,
    enableSignOut: true,
    enabled: true,
  },
  {
    id: "AFTERNOON",
    name: "Afternoon Shift",
    arrivalCutoff: "14:00",
    lateTolerance: "14:30",
    signOutTime: "22:00",
    allowLateSignIn: true,
    enableSignOut: true,
    enabled: true,
  },
  {
    id: "NIGHT",
    name: "Night Shift",
    arrivalCutoff: "22:00",
    lateTolerance: "22:30",
    signOutTime: "06:00",
    allowLateSignIn: true,
    enableSignOut: true,
    enabled: true,
  },
];

const COUNTRIES = [...QUICK_COUNTRIES, "Other"];

const DEPARTMENT_PRESETS = [
  "Engineering & Technology",
  "Operations & Logistics",
  "Media, Creative & Marketing",
  "Administration & HR",
  "Finance & Accounting",
  "Customer Support & Success",
  "Security & Facility Management",
  "Legal & Compliance",
  "Executive & Management",
];

const WEEK_DAYS = [
  { id: 0, name: "Sun", label: "Sunday" },
  { id: 1, name: "Mon", label: "Monday" },
  { id: 2, name: "Tue", label: "Tuesday" },
  { id: 3, name: "Wed", label: "Wednesday" },
  { id: 4, name: "Thu", label: "Thursday" },
  { id: 5, name: "Fri", label: "Friday" },
  { id: 6, name: "Sat", label: "Saturday" },
];

const TIME_PRESETS = ["07:00", "07:30", "08:00", "08:30", "09:00", "17:00", "18:00"];

function generateRandomOrgCode(): string {
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let p1 = "";
  let p2 = "";
  for (let i = 0; i < 2; i++) p1 += letters.charAt(Math.floor(Math.random() * letters.length));
  for (let i = 0; i < 3; i++) p2 += letters.charAt(Math.floor(Math.random() * letters.length));
  const p3 = Math.floor(100 + Math.random() * 900);
  return `${p1}-${p2}-${p3}`;
}

function isValidTimeHHMM(val: string): boolean {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(val.trim());
}

export default function AdminOnboardingScreen() {
  const { user, organization, isAdmin, createAdminOrg, signOut } = useAuth();
  const toast = useToast();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [submitting, setSubmitting] = useState(false);
  const [submitStepLabel, setSubmitStepLabel] = useState("Creating workspace...");

  // Step 1: Organization & Admin Identity
  const [churchName, setChurchName] = useState("");
  const [branchName, setBranchName] = useState("Main Campus");
  const [churchCode, setChurchCode] = useState(() => generateRandomOrgCode());
  const [adminName, setAdminName] = useState(user?.displayName || "");
  const [adminPhone, setAdminPhone] = useState("");
  const [country, setCountry] = useState("Nigeria");
  const [stateName, setStateName] = useState("");
  const [city, setCity] = useState("");
  const [pickerTarget, setPickerTarget] = useState<"country" | "state" | "city" | null>(null);

  // Step 2: Workforce Units / Departments
  const [departments, setDepartments] = useState<string[]>([
    "Operations & Logistics",
    "Administration & HR",
    "Engineering & Technology",
  ]);
  const [customDept, setCustomDept] = useState("");

  // Step 3: Service Days & Policy
  const [serviceDays, setServiceDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [scheduleMode, setScheduleMode] = useState<"UNIFIED" | "PER_DAY" | "MULTI_SHIFT">("UNIFIED");
  const [arrivalCutoff, setArrivalCutoff] = useState("08:00");
  const [lateTolerance, setLateTolerance] = useState("08:30");
  const [allowLateSignIn, setAllowLateSignIn] = useState(true);
  const [enableSignOut, setEnableSignOut] = useState(true);
  const [signOutTime, setSignOutTime] = useState("17:00");
  const [daySchedules, setDaySchedules] = useState<Record<number, DaySchedule>>({});
  const [activeScheduleDay, setActiveScheduleDay] = useState<number>(1);
  const [shifts, setShifts] = useState<ShiftSchedule[]>(DEFAULT_SHIFTS);

  const updateShift = (shiftId: string, patch: Partial<ShiftSchedule>) => {
    setShifts((prev) =>
      prev.map((s) => (s.id === shiftId ? { ...s, ...patch } : s))
    );
  };

  const addCustomShift = () => {
    const idx = shifts.length + 1;
    setShifts((prev) => [
      ...prev,
      {
        id: `SHIFT_${Date.now().toString(36)}`,
        name: `Shift ${idx}`,
        arrivalCutoff: "09:00",
        lateTolerance: "09:30",
        signOutTime: "17:00",
        allowLateSignIn: true,
        enableSignOut: true,
        enabled: true,
      },
    ]);
  };

  const removeShift = (shiftId: string) => {
    if (shifts.length <= 1) return;
    setShifts((prev) => prev.filter((s) => s.id !== shiftId));
  };

  const draftKey = user?.uid ? `@presenti_admin_onboarding_${user.uid}` : null;
  const draftLoadedRef = useRef(false);
  const hasNavigatedRef = useRef(false);

  useEffect(() => {
    if (hasNavigatedRef.current) return;
    if (!user) {
      hasNavigatedRef.current = true;
      router.replace("/login");
      return;
    }
    if (!isAdmin && !user.isAdmin) {
      hasNavigatedRef.current = true;
      router.replace("/onboarding");
      return;
    }
    if (organization) {
      hasNavigatedRef.current = true;
      router.replace("/");
    }
  }, [user, isAdmin, organization]);

  useEffect(() => {
    if (user?.displayName && !adminName) {
      setAdminName(user.displayName);
    }
  }, [user?.displayName]);

  // Restore saved draft
  useEffect(() => {
    if (!draftKey) return;
    let active = true;
    AsyncStorage.getItem(draftKey)
      .then((raw) => {
        if (!active) return;
        draftLoadedRef.current = true;
        if (!raw) return;
        try {
          const d = JSON.parse(raw);
          if (d.step) setStep(d.step);
          if (d.churchName) setChurchName(d.churchName);
          if (d.branchName) setBranchName(d.branchName);
          if (d.churchCode) setChurchCode(d.churchCode);
          if (d.adminName) setAdminName(d.adminName);
          if (d.adminPhone) setAdminPhone(d.adminPhone);
          if (d.country) setCountry(d.country);
          if (d.stateName) setStateName(d.stateName);
          if (d.city) setCity(d.city);
          if (Array.isArray(d.departments)) setDepartments(d.departments);
          if (Array.isArray(d.serviceDays)) setServiceDays(d.serviceDays);
          if (d.scheduleMode) setScheduleMode(d.scheduleMode);
          if (d.arrivalCutoff) setArrivalCutoff(d.arrivalCutoff);
          if (d.lateTolerance) setLateTolerance(d.lateTolerance);
          if (typeof d.allowLateSignIn === "boolean") setAllowLateSignIn(d.allowLateSignIn);
          if (typeof d.enableSignOut === "boolean") setEnableSignOut(d.enableSignOut);
          if (d.signOutTime) setSignOutTime(d.signOutTime);
          if (d.daySchedules) setDaySchedules(d.daySchedules);
        } catch {}
      })
      .catch(() => {
        draftLoadedRef.current = true;
      });
    return () => {
      active = false;
    };
  }, [draftKey]);

  // Auto-save draft
  useEffect(() => {
    if (!draftKey || !draftLoadedRef.current) return;
    AsyncStorage.setItem(
      draftKey,
      JSON.stringify({
        step,
        churchName,
        branchName,
        churchCode,
        adminName,
        adminPhone,
        country,
        stateName,
        city,
        departments,
        serviceDays,
        scheduleMode,
        arrivalCutoff,
        lateTolerance,
        allowLateSignIn,
        enableSignOut,
        signOutTime,
        daySchedules,
      })
    ).catch(() => {});
  }, [
    draftKey,
    step,
    churchName,
    branchName,
    churchCode,
    adminName,
    adminPhone,
    country,
    stateName,
    city,
    departments,
    serviceDays,
    scheduleMode,
    arrivalCutoff,
    lateTolerance,
    allowLateSignIn,
    enableSignOut,
    signOutTime,
    daySchedules,
  ]);

  const handleRegenerateCode = () => {
    const next = generateRandomOrgCode();
    setChurchCode(next);
    toast.info(`Generated organization code: ${next}`);
  };

  const handleCopyCode = async () => {
    await Clipboard.setStringAsync(churchCode);
    toast.success(`Copied "${churchCode}" to clipboard!`);
  };

  const togglePresetDepartment = (dept: string) => {
    setDepartments((prev) =>
      prev.includes(dept) ? prev.filter((d) => d !== dept) : [...prev, dept]
    );
  };

  const addCustomDepartment = () => {
    const clean = customDept.trim();
    if (!clean) return;
    if (departments.some((d) => d.toLowerCase() === clean.toLowerCase())) {
      toast.warn(`"${clean}" is already added.`);
      return;
    }
    setDepartments((prev) => [...prev, clean]);
    setCustomDept("");
  };

  const toggleServiceDay = (dayId: number) => {
    setServiceDays((prev) => {
      if (prev.includes(dayId)) {
        if (prev.length === 1) {
          toast.warn("At least one active work day is required.");
          return prev;
        }
        const next = prev.filter((d) => d !== dayId);
        if (activeScheduleDay === dayId && next.length > 0) {
          setActiveScheduleDay(next[0]);
        }
        return next;
      }
      return [...prev, dayId].sort((a, b) => a - b);
    });
  };

  const getActiveDaySchedule = (dayId: number): DaySchedule => {
    return (
      daySchedules[dayId] || {
        arrivalCutoff,
        lateTolerance,
        allowLateSignIn,
        enableSignOut,
        signOutTime,
      }
    );
  };

  const updateDaySchedule = (dayId: number, patch: Partial<DaySchedule>) => {
    setDaySchedules((prev) => ({
      ...prev,
      [dayId]: {
        ...getActiveDaySchedule(dayId),
        ...patch,
      },
    }));
  };

  const copyActiveDayToAll = () => {
    const activeSched = getActiveDaySchedule(activeScheduleDay);
    const next: Record<number, DaySchedule> = {};
    serviceDays.forEach((d) => {
      next[d] = { ...activeSched };
    });
    setDaySchedules(next);
    const label = WEEK_DAYS.find((w) => w.id === activeScheduleDay)?.label || "Selected day";
    toast.success(`Applied ${label}'s schedule to all ${serviceDays.length} active days.`);
  };

  const handleNextStep = () => {
    if (step === 1) {
      if (churchName.trim().length < 2) {
        toast.warn("Please enter your organization name.");
        return;
      }
      if (!branchName.trim()) {
        toast.warn("Please enter your branch or campus name.");
        return;
      }
      if (churchCode.trim().length < 5) {
        toast.warn("Please enter or generate a valid organization code.");
        return;
      }
      if (adminName.trim().length < 2) {
        toast.warn("Please enter the administrator's full name.");
        return;
      }
      setStep(2);
      return;
    }

    if (step === 2) {
      if (departments.length === 0) {
        toast.warn("Please add at least one workforce department or unit.");
        return;
      }
      setStep(3);
    }
  };

  const handleCompleteOnboarding = async () => {
    if (scheduleMode === "UNIFIED") {
      if (!isValidTimeHHMM(arrivalCutoff) || !isValidTimeHHMM(lateTolerance)) {
        toast.warn("Use 24-hour HH:MM format for open and cutoff times (e.g. 08:00).");
        return;
      }
      if (lateTolerance < arrivalCutoff) {
        toast.warn("Punctuality cutoff cannot be earlier than window open time.");
        return;
      }
      if (enableSignOut && !isValidTimeHHMM(signOutTime)) {
        toast.warn("Use 24-hour HH:MM format for sign-out time (e.g. 17:00).");
        return;
      }
    }

    setSubmitting(true);
    setSubmitStepLabel("Creating workspace...");
    try {
      setSubmitStepLabel("Saving policy & anchors...");
      await createAdminOrg({
        adminName: adminName.trim(),
        adminPhone: adminPhone.trim(),
        churchName: churchName.trim(),
        branchName: branchName.trim(),
        churchCode: churchCode.trim().toUpperCase(),
        country: country.trim(),
        state: stateName.trim(),
        city: city.trim(),
        departments,
        policySettings: {
          serviceDays,
          scheduleMode,
          arrivalCutoff,
          lateTolerance,
          allowLateSignIn,
          enableSignOut,
          signOutTime,
          ...(scheduleMode === "PER_DAY" ? { daySchedules } : {}),
          ...(scheduleMode === "MULTI_SHIFT" ? { shifts } : {}),
        },
      });

      if (draftKey) {
        AsyncStorage.removeItem(draftKey).catch(() => {});
      }

      toast.success(`${churchName.trim()} workspace created! Welcome to Field Admin Hub.`, {
        title: "Workspace Ready",
        duration: 4000,
      });
      if (!hasNavigatedRef.current) {
        hasNavigatedRef.current = true;
        router.replace("/");
      }
    } catch (err: any) {
      toast.error(err?.message || "Failed to create organization workspace.");
    } finally {
      setSubmitting(false);
    }
  };

  const activeDaySched = getActiveDaySchedule(activeScheduleDay);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={[styles.scrollContent, { paddingBottom: 36 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          {/* Top Header */}
          <View style={styles.header}>
            <View style={styles.headerTopRow}>
              <View style={styles.stepPill}>
                <View style={styles.stepDot} />
                <Text style={styles.stepPillText}>ADMIN ONBOARDING • STEP {step} OF 3</Text>
              </View>
              <TouchableOpacity
                onPress={async () => {
                  await signOut();
                  router.replace("/login");
                }}
                style={styles.signOutLinkBtn}
                activeOpacity={0.7}
              >
                <Ionicons name="log-out-outline" size={14} color={C.muted} />
                <Text style={styles.signOutLinkText}>Sign Out</Text>
              </TouchableOpacity>
            </View>

            <Text style={styles.title}>
              {step === 1 && "Organization Identity"}
              {step === 2 && "Workforce Units"}
              {step === 3 && "Schedule & Arrival Policy"}
            </Text>
            <Text style={styles.subtitle}>
              {step === 1 && "Create your workspace and worker pairing code."}
              {step === 2 && "Add departments for your team."}
              {step === 3 && "Set work days and arrival cutoffs."}
            </Text>

            {/* Progress Bar */}
            <View style={styles.progressTrack}>
              {[1, 2, 3].map((s) => (
                <View
                  key={s}
                  style={[
                    styles.progressSegment,
                    step >= s && styles.progressSegmentActive,
                  ]}
                />
              ))}
            </View>
          </View>

          {/* STEP 1: IDENTITY & LOCATION */}
          {step === 1 && (
            <View style={styles.card}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>ORGANIZATION NAME</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Grace Consulate / Acme Corp"
                  placeholderTextColor={C.faint}
                  value={churchName}
                  onChangeText={setChurchName}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>BRANCH / CAMPUS NAME</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. Main Campus / HQ"
                  placeholderTextColor={C.faint}
                  value={branchName}
                  onChangeText={setBranchName}
                />
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>UNIQUE ORGANIZATION CODE</Text>
                <View style={styles.codeBox}>
                  <TextInput
                    style={styles.codeInput}
                    value={churchCode}
                    onChangeText={(t) => setChurchCode(t.toUpperCase())}
                    autoCapitalize="characters"
                    maxLength={12}
                  />
                  <TouchableOpacity onPress={handleCopyCode} style={styles.codeIconBtn}>
                    <Ionicons name="copy-outline" size={16} color={C.ink} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={handleRegenerateCode} style={styles.codeIconBtn}>
                    <Ionicons name="refresh-outline" size={16} color={C.accent} />
                  </TouchableOpacity>
                </View>
                <Text style={styles.helperText}>
                  Share this code with workers so they can pair their phones to your workspace.
                </Text>
              </View>

              <View style={styles.row2}>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.label}>ADMIN FULL NAME</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="Full name"
                    placeholderTextColor={C.faint}
                    value={adminName}
                    onChangeText={setAdminName}
                  />
                </View>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.label}>ADMIN PHONE</Text>
                  <TextInput
                    style={styles.input}
                    placeholder="+234..."
                    placeholderTextColor={C.faint}
                    keyboardType="phone-pad"
                    value={adminPhone}
                    onChangeText={setAdminPhone}
                  />
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>COUNTRY</Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8 }}
                >
                  {COUNTRIES.map((c) => {
                    const isOtherActive =
                      c === "Other" && !QUICK_COUNTRIES.includes(country);
                    const isSelected = c === country || isOtherActive;
                    return (
                      <TouchableOpacity
                        key={c}
                        style={[styles.chip, isSelected && styles.chipActive]}
                        onPress={() => {
                          if (c === "Other") {
                            setPickerTarget("country");
                          } else {
                            setCountry(c);
                            setStateName("");
                            setCity("");
                          }
                        }}
                      >
                        <Text
                          style={[
                            styles.chipText,
                            isSelected && styles.chipTextActive,
                          ]}
                        >
                          {c === "Other" && isOtherActive ? `${country} ▾` : c === "Other" ? "Other ▾" : c}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>

              <View style={styles.row2}>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.label}>STATE / REGION</Text>
                  <TouchableOpacity
                    style={[styles.input, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}
                    onPress={() => setPickerTarget("state")}
                    activeOpacity={0.75}
                  >
                    <Text
                      style={{
                        fontSize: rf(14),
                        color: stateName ? C.ink : C.faint,
                        fontWeight: stateName ? "600" : "400",
                        flex: 1,
                      }}
                      numberOfLines={1}
                    >
                      {stateName || "Select state"}
                    </Text>
                    <Ionicons name="chevron-down" size={16} color={C.muted} />
                  </TouchableOpacity>
                </View>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.label}>CITY / LGA</Text>
                  <TouchableOpacity
                    style={[styles.input, { flexDirection: "row", alignItems: "center", justifyContent: "space-between" }]}
                    onPress={() => {
                      if (!stateName && getStatesForCountry(country).length > 0) {
                        toast.info(`Select a state in ${country} first.`);
                        setPickerTarget("state");
                        return;
                      }
                      setPickerTarget("city");
                    }}
                    activeOpacity={0.75}
                  >
                    <Text
                      style={{
                        fontSize: rf(14),
                        color: city ? C.ink : C.faint,
                        fontWeight: city ? "600" : "400",
                        flex: 1,
                      }}
                      numberOfLines={1}
                    >
                      {city || "Select city / LGA"}
                    </Text>
                    <Ionicons name="chevron-down" size={16} color={C.muted} />
                  </TouchableOpacity>
                </View>
              </View>

              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={handleNextStep}
                activeOpacity={0.85}
              >
                <Text style={styles.primaryBtnText}>CONTINUE TO DEPARTMENTS</Text>
                <Ionicons name="arrow-forward" size={18} color={C.white} />
              </TouchableOpacity>
            </View>
          )}

          {/* STEP 2: WORKFORCE UNITS / DEPARTMENTS */}
          {step === 2 && (
            <View style={styles.card}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>ADD CUSTOM DEPARTMENT / UNIT</Text>
                <View style={styles.addRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="e.g. Field Sales / Choir"
                    placeholderTextColor={C.faint}
                    value={customDept}
                    onChangeText={setCustomDept}
                    onSubmitEditing={addCustomDepartment}
                  />
                  <TouchableOpacity
                    style={styles.addBtn}
                    onPress={addCustomDepartment}
                    activeOpacity={0.85}
                  >
                    <Ionicons name="add" size={20} color={C.white} />
                  </TouchableOpacity>
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>ACTIVE DEPARTMENTS ({departments.length})</Text>
                <View style={styles.chipsWrap}>
                  {departments.map((dept) => (
                    <View key={dept} style={styles.activeDeptPill}>
                      <Text style={styles.activeDeptText}>{dept}</Text>
                      <TouchableOpacity
                        onPress={() =>
                          setDepartments((prev) => prev.filter((d) => d !== dept))
                        }
                      >
                        <Ionicons name="close-circle" size={16} color={C.accent} />
                      </TouchableOpacity>
                    </View>
                  ))}
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>QUICK PRESET UNITS</Text>
                <View style={styles.chipsWrap}>
                  {DEPARTMENT_PRESETS.map((preset) => {
                    const selected = departments.includes(preset);
                    return (
                      <TouchableOpacity
                        key={preset}
                        style={[styles.chip, selected && styles.chipActive]}
                        onPress={() => togglePresetDepartment(preset)}
                      >
                        <Text
                          style={[
                            styles.chipText,
                            selected && styles.chipTextActive,
                          ]}
                        >
                          {selected ? "✓ " : "+ "}
                          {preset}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.navRow}>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => setStep(1)}
                >
                  <Ionicons name="arrow-back" size={18} color={C.ink} />
                  <Text style={styles.secondaryBtnText}>BACK</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.primaryBtn, { flex: 1 }]}
                  onPress={handleNextStep}
                >
                  <Text style={styles.primaryBtnText}>CONTINUE TO POLICY</Text>
                  <Ionicons name="arrow-forward" size={18} color={C.white} />
                </TouchableOpacity>
              </View>
            </View>
          )}

          {/* STEP 3: SCHEDULE & ARRIVAL POLICY */}
          {step === 3 && (
            <View style={styles.card}>
              <View style={styles.fieldGroup}>
                <Text style={styles.label}>ACTIVE WORK / SERVICE DAYS</Text>
                <View style={styles.daysRow}>
                  {WEEK_DAYS.map((d) => {
                    const active = serviceDays.includes(d.id);
                    return (
                      <TouchableOpacity
                        key={d.id}
                        style={[styles.dayPill, active && styles.dayPillActive]}
                        onPress={() => toggleServiceDay(d.id)}
                      >
                        <Text
                          style={[
                            styles.dayPillText,
                            active && styles.dayPillTextActive,
                          ]}
                        >
                          {d.name}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
              </View>

              <View style={styles.fieldGroup}>
                <Text style={styles.label}>SCHEDULE MODE</Text>
                <View style={styles.segmentRow}>
                  <TouchableOpacity
                    style={[
                      styles.segmentBtn,
                      scheduleMode === "UNIFIED" && styles.segmentBtnActive,
                    ]}
                    onPress={() => setScheduleMode("UNIFIED")}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        scheduleMode === "UNIFIED" && styles.segmentTextActive,
                      ]}
                    >
                      Unified
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.segmentBtn,
                      scheduleMode === "PER_DAY" && styles.segmentBtnActive,
                    ]}
                    onPress={() => setScheduleMode("PER_DAY")}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        scheduleMode === "PER_DAY" && styles.segmentTextActive,
                      ]}
                    >
                      Per Day
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[
                      styles.segmentBtn,
                      scheduleMode === "MULTI_SHIFT" && styles.segmentBtnActive,
                    ]}
                    onPress={() => setScheduleMode("MULTI_SHIFT")}
                  >
                    <Text
                      style={[
                        styles.segmentText,
                        scheduleMode === "MULTI_SHIFT" && styles.segmentTextActive,
                      ]}
                    >
                      Multi-Shift
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {scheduleMode === "MULTI_SHIFT" ? (
                <ShiftScheduleEditor
                  shifts={shifts}
                  serviceDays={serviceDays}
                  onChangeShifts={setShifts}
                />
              ) : (
                <>

              {scheduleMode === "PER_DAY" && (
                <View style={styles.fieldGroup}>
                  <View style={styles.perDayHeader}>
                    <Text style={styles.label}>EDITING DAY</Text>
                    <TouchableOpacity onPress={copyActiveDayToAll}>
                      <Text style={styles.copyLinkText}>Copy to all active days</Text>
                    </TouchableOpacity>
                  </View>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={{ gap: 8 }}
                  >
                    {serviceDays.map((dayId) => {
                      const label = WEEK_DAYS.find((w) => w.id === dayId)?.name || "";
                      const active = activeScheduleDay === dayId;
                      return (
                        <TouchableOpacity
                          key={dayId}
                          style={[styles.chip, active && styles.chipActive]}
                          onPress={() => setActiveScheduleDay(dayId)}
                        >
                          <Text
                            style={[
                              styles.chipText,
                              active && styles.chipTextActive,
                            ]}
                          >
                            {label}
                          </Text>
                        </TouchableOpacity>
                      );
                    })}
                  </ScrollView>
                </View>
              )}

              <View style={styles.row2}>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.label}>WINDOW OPEN (24H)</Text>
                  <TextInput
                    style={styles.input}
                    value={
                      scheduleMode === "UNIFIED"
                        ? arrivalCutoff
                        : activeDaySched.arrivalCutoff || "08:00"
                    }
                    onChangeText={(v) =>
                      scheduleMode === "UNIFIED"
                        ? setArrivalCutoff(v)
                        : updateDaySchedule(activeScheduleDay, { arrivalCutoff: v })
                    }
                    placeholder="08:00"
                  />
                </View>
                <View style={[styles.fieldGroup, { flex: 1 }]}>
                  <Text style={styles.label}>ON-TIME CUTOFF (24H)</Text>
                  <TextInput
                    style={styles.input}
                    value={
                      scheduleMode === "UNIFIED"
                        ? lateTolerance
                        : activeDaySched.lateTolerance || "08:30"
                    }
                    onChangeText={(v) =>
                      scheduleMode === "UNIFIED"
                        ? setLateTolerance(v)
                        : updateDaySchedule(activeScheduleDay, { lateTolerance: v })
                    }
                    placeholder="08:30"
                  />
                </View>
              </View>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: 6, marginBottom: 10 }}
              >
                {TIME_PRESETS.slice(0, 5).map((tp) => (
                  <TouchableOpacity
                    key={tp}
                    style={styles.presetChip}
                    onPress={() => {
                      if (scheduleMode === "UNIFIED") setArrivalCutoff(tp);
                      else updateDaySchedule(activeScheduleDay, { arrivalCutoff: tp });
                    }}
                  >
                    <Text style={styles.presetChipText}>Open {tp}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchTitle}>Enable Mandatory Sign-Out</Text>
                  <Text style={styles.switchSub}>
                    Require workers to scan out at departure
                  </Text>
                </View>
                <Switch
                  value={
                    scheduleMode === "UNIFIED"
                      ? enableSignOut
                      : Boolean(activeDaySched.enableSignOut)
                  }
                  onValueChange={(v) =>
                    scheduleMode === "UNIFIED"
                      ? setEnableSignOut(v)
                      : updateDaySchedule(activeScheduleDay, { enableSignOut: v })
                  }
                  trackColor={{ false: C.line, true: C.accent }}
                />
              </View>

              {(scheduleMode === "UNIFIED"
                ? enableSignOut
                : Boolean(activeDaySched.enableSignOut)) && (
                <View style={styles.fieldGroup}>
                  <Text style={styles.label}>SIGN-OUT OPEN TIME (24H)</Text>
                  <TextInput
                    style={styles.input}
                    value={
                      scheduleMode === "UNIFIED"
                        ? signOutTime
                        : activeDaySched.signOutTime || "17:00"
                    }
                    onChangeText={(v) =>
                      scheduleMode === "UNIFIED"
                        ? setSignOutTime(v)
                        : updateDaySchedule(activeScheduleDay, { signOutTime: v })
                    }
                    placeholder="17:00"
                  />
                </View>
              )}
                </>
              )}

              {/* Global Standalone Allow Late Check-In (Applies to Unified, Per Day & Multi-Shift) */}
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.switchTitle}>Allow Late Check-In</Text>
                  <Text style={styles.switchSub}>
                    Permit arrivals after cutoff (tagged LATE) across all modes
                  </Text>
                </View>
                <Switch
                  value={allowLateSignIn}
                  onValueChange={setAllowLateSignIn}
                  trackColor={{ false: C.line, true: C.accent }}
                />
              </View>

              <View style={styles.navRow}>
                <TouchableOpacity
                  style={styles.secondaryBtn}
                  onPress={() => setStep(2)}
                  disabled={submitting}
                >
                  <Ionicons name="arrow-back" size={18} color={C.ink} />
                  <Text style={styles.secondaryBtnText}>BACK</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[
                    styles.primaryBtn,
                    { flex: 1, backgroundColor: C.success },
                    submitting && { opacity: 0.7 },
                  ]}
                  onPress={handleCompleteOnboarding}
                  disabled={submitting}
                >
                  {submitting ? (
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <ActivityIndicator size="small" color={C.white} />
                      <Text style={styles.primaryBtnText} numberOfLines={1}>
                        {submitStepLabel.toUpperCase()}
                      </Text>
                    </View>
                  ) : (
                    <>
                      <Text style={styles.primaryBtnText}>LAUNCH WORKSPACE</Text>
                      <Ionicons name="checkmark-circle" size={18} color={C.white} />
                    </>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      <LocationPickerModal
        visible={pickerTarget !== null}
        title={
          pickerTarget === "country"
            ? "Select Country"
            : pickerTarget === "state"
              ? `Select State in ${country}`
              : `Select City / LGA in ${stateName || country}`
        }
        placeholder={
          pickerTarget === "country"
            ? "Search country..."
            : pickerTarget === "state"
              ? "Search state A–Z..."
              : "Search city or LGA..."
        }
        options={
          pickerTarget === "country"
            ? ALL_COUNTRIES_AZ
            : pickerTarget === "state"
              ? getStatesForCountry(country)
              : getCitiesForState(country, stateName)
        }
        selectedValue={
          pickerTarget === "country"
            ? country
            : pickerTarget === "state"
              ? stateName
              : city
        }
        onSelect={(val) => {
          if (pickerTarget === "country") {
            setCountry(val);
            setStateName("");
            setCity("");
          } else if (pickerTarget === "state") {
            setStateName(val);
            setCity("");
          } else if (pickerTarget === "city") {
            setCity(val);
          }
        }}
        onClose={() => setPickerTarget(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: C.canvas },
  scrollContent: {
    paddingHorizontal: S.screenX,
    paddingVertical: S.lg,
    flexGrow: 1,
    maxWidth: 560,
    width: "100%",
    alignSelf: "center",
  },
  header: { marginBottom: 18 },
  headerTopRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  stepPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.accentSoft,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: R.pill,
  },
  stepDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: C.accent,
  },
  stepPillText: {
    ...T.labelSm,
    color: C.accent,
  },
  signOutLinkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  signOutLinkText: {
    ...T.caption,
    fontWeight: "700",
    color: C.muted,
  },
  title: {
    ...T.display,
    fontSize: 26,
    marginBottom: 4,
  },
  subtitle: {
    ...T.body,
    color: C.muted,
    marginBottom: 14,
  },
  progressTrack: {
    flexDirection: "row",
    gap: 8,
  },
  progressSegment: {
    flex: 1,
    height: 4,
    borderRadius: 2,
    backgroundColor: C.line,
  },
  progressSegmentActive: {
    backgroundColor: C.accent,
  },
  card: {
    ...ui.card,
    padding: 18,
    gap: 14,
    ...shadow.card,
  },
  fieldGroup: {
    gap: 6,
  },
  label: {
    ...T.labelSm,
    color: C.muted,
  },
  input: {
    height: 46,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.lineCard,
    borderRadius: R.md,
    paddingHorizontal: 12,
    fontSize: 14,
    color: C.ink,
    fontWeight: "600",
  },
  codeBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.lineCard,
    borderRadius: R.md,
    paddingHorizontal: 10,
    height: 48,
    gap: 6,
  },
  codeInput: {
    flex: 1,
    fontFamily: MONO,
    fontSize: 16,
    fontWeight: "800",
    color: C.ink,
    letterSpacing: 1.5,
  },
  codeIconBtn: {
    width: 34,
    height: 34,
    borderRadius: R.sm,
    backgroundColor: C.card,
    alignItems: "center",
    justifyContent: "center",
  },
  helperText: {
    ...T.caption,
    fontSize: 11.5,
  },
  row2: {
    flexDirection: "row",
    gap: 10,
  },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  chipActive: {
    backgroundColor: C.ink,
    borderColor: C.ink,
  },
  chipText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: C.ink2,
  },
  chipTextActive: {
    color: C.white,
  },
  addRow: {
    flexDirection: "row",
    gap: 8,
  },
  addBtn: {
    width: 46,
    height: 46,
    borderRadius: R.md,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  chipsWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  activeDeptPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.accentSoft,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: R.pill,
  },
  activeDeptText: {
    fontSize: 12.5,
    fontWeight: "700",
    color: C.ink,
  },
  daysRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 6,
  },
  dayPill: {
    flex: 1,
    height: 40,
    borderRadius: R.md,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.lineCard,
    alignItems: "center",
    justifyContent: "center",
  },
  dayPillActive: {
    backgroundColor: C.ink,
    borderColor: C.ink,
  },
  dayPillText: {
    fontSize: 12,
    fontWeight: "700",
    color: C.muted,
  },
  dayPillTextActive: {
    color: C.white,
  },
  segmentRow: {
    flexDirection: "row",
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    padding: 4,
    gap: 4,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 9,
    borderRadius: R.sm,
    alignItems: "center",
  },
  segmentBtnActive: {
    backgroundColor: C.card,
    ...shadow.card,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: "600",
    color: C.muted,
  },
  segmentTextActive: {
    color: C.ink,
    fontWeight: "800",
  },
  perDayHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  copyLinkText: {
    fontSize: 12,
    fontWeight: "700",
    color: C.accent,
  },
  presetChip: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: R.pill,
    backgroundColor: C.accentSoft,
  },
  presetChipText: {
    fontSize: 11,
    fontWeight: "700",
    color: C.accent,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: C.lineCard,
  },
  switchTitle: {
    ...T.heading,
    fontSize: 14,
  },
  switchSub: {
    ...T.caption,
    fontSize: 12,
  },
  navRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 6,
  },
  primaryBtn: {
    height: 50,
    borderRadius: R.md,
    backgroundColor: C.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 4,
  },
  primaryBtnText: {
    ...T.labelSm,
    color: C.white,
    fontSize: rf(11.5),
  },
  secondaryBtn: {
    height: 50,
    paddingHorizontal: 14,
    borderRadius: R.md,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.lineCard,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: 4,
  },
  secondaryBtnText: {
    ...T.labelSm,
    color: C.ink,
    fontSize: rf(11.5),
  },
});
