import React, { useState, useEffect } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Switch,
  Alert,
  ActivityIndicator,
} from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import { C, MONO, R, T, shadow, ui, rf } from "../constants/premium";
import type { DaySchedule, ShiftSchedule } from "../types";

const DEFAULT_SHIFTS: ShiftSchedule[] = [
  { id: "MORNING", name: "Morning Shift", arrivalCutoff: "06:00", lateTolerance: "06:30", signOutTime: "14:00", allowLateSignIn: true, enableSignOut: true, enabled: true },
  { id: "AFTERNOON", name: "Afternoon Shift", arrivalCutoff: "14:00", lateTolerance: "14:30", signOutTime: "22:00", allowLateSignIn: true, enableSignOut: true, enabled: true },
  { id: "NIGHT", name: "Night Shift", arrivalCutoff: "22:00", lateTolerance: "22:30", signOutTime: "06:00", allowLateSignIn: true, enableSignOut: true, enabled: true },
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

export const AdminManageTab: React.FC = () => {
  const { organization, updateOrgSettings, deleteAdminOrg } = useAuth();
  const toast = useToast();

  const [churchName, setChurchName] = useState(organization?.churchName || "");
  const [branchName, setBranchName] = useState(organization?.branchName || "");
  const [departments, setDepartments] = useState<string[]>(
    organization?.departments || ["General Workforce"]
  );
  const [newDept, setNewDept] = useState("");

  const [serviceDays, setServiceDays] = useState<number[]>(
    (organization?.policySettings?.serviceDays || [1, 2, 3, 4, 5]).map((d) => Number(d))
  );
  const [scheduleMode, setScheduleMode] = useState<"UNIFIED" | "PER_DAY" | "MULTI_SHIFT">(
    organization?.policySettings?.scheduleMode === "MULTI_SHIFT"
      ? "MULTI_SHIFT"
      : organization?.policySettings?.scheduleMode === "PER_DAY"
        ? "PER_DAY"
        : "UNIFIED"
  );
  const [arrivalCutoff, setArrivalCutoff] = useState(
    organization?.policySettings?.arrivalCutoff || "08:00"
  );
  const [lateTolerance, setLateTolerance] = useState(
    organization?.policySettings?.lateTolerance || "08:30"
  );
  const [allowLateSignIn, setAllowLateSignIn] = useState(
    organization?.policySettings?.allowLateSignIn ?? true
  );
  const [enableSignOut, setEnableSignOut] = useState(
    organization?.policySettings?.enableSignOut ?? false
  );
  const [signOutTime, setSignOutTime] = useState(
    organization?.policySettings?.signOutTime || "17:00"
  );
  const [daySchedules, setDaySchedules] = useState<Record<number, DaySchedule>>(
    (organization?.policySettings?.daySchedules as Record<number, DaySchedule>) || {}
  );
  const [activeScheduleDay, setActiveScheduleDay] = useState<number>(1);
  const [shifts, setShifts] = useState<ShiftSchedule[]>(
    organization?.policySettings?.shifts && organization.policySettings.shifts.length > 0
      ? organization.policySettings.shifts
      : DEFAULT_SHIFTS
  );

  const updateShift = (shiftId: string, patch: Partial<ShiftSchedule>) => {
    setShifts((prev) => prev.map((s) => (s.id === shiftId ? { ...s, ...patch } : s)));
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

  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  useEffect(() => {
    if (!organization) return;
    setChurchName(organization.churchName || "");
    setBranchName(organization.branchName || "");
    setDepartments(
      organization.departments && organization.departments.length > 0
        ? organization.departments
        : ["General Workforce"]
    );
    const p = organization.policySettings;
    if (p) {
      if (Array.isArray(p.serviceDays) && p.serviceDays.length > 0) {
        const nums = p.serviceDays.map((d) => Number(d));
        setServiceDays(nums);
        setActiveScheduleDay(nums[0]);
      }
      setScheduleMode(
        p.scheduleMode === "MULTI_SHIFT"
          ? "MULTI_SHIFT"
          : p.scheduleMode === "PER_DAY"
            ? "PER_DAY"
            : "UNIFIED"
      );
      if (Array.isArray(p.shifts) && p.shifts.length > 0) {
        setShifts(p.shifts);
      }
      if (p.arrivalCutoff) setArrivalCutoff(p.arrivalCutoff);
      if (p.lateTolerance) setLateTolerance(p.lateTolerance);
      if (typeof p.allowLateSignIn === "boolean") setAllowLateSignIn(p.allowLateSignIn);
      if (typeof p.enableSignOut === "boolean") setEnableSignOut(p.enableSignOut);
      if (p.signOutTime) setSignOutTime(p.signOutTime);
      if (p.daySchedules) {
        setDaySchedules(p.daySchedules as Record<number, DaySchedule>);
      }
    }
  }, [organization?.id]);

  const handleCopyCode = async () => {
    if (!organization?.churchCode) return;
    await Clipboard.setStringAsync(organization.churchCode);
    toast.success(`Copied "${organization.churchCode}" to clipboard!`);
  };

  const handleAddDept = () => {
    const clean = newDept.trim();
    if (!clean) return;
    if (departments.some((d) => d.toLowerCase() === clean.toLowerCase())) {
      toast.warn(`"${clean}" already exists.`);
      return;
    }
    setDepartments((prev) => [...prev, clean]);
    setNewDept("");
  };

  const toggleDay = (dayId: number) => {
    setServiceDays((prev) => {
      if (prev.includes(dayId)) {
        if (prev.length === 1) {
          toast.warn("At least one active day is required.");
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

  const handleSaveChanges = async () => {
    if (churchName.trim().length < 2) {
      toast.warn("Organization name must be at least 2 characters.");
      return;
    }
    if (departments.length === 0) {
      toast.warn("At least one department is required.");
      return;
    }

    setIsSaving(true);
    try {
      await updateOrgSettings({
        churchName: churchName.trim(),
        branchName: branchName.trim() || "Main Campus",
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
      toast.success("Organization settings saved and synced in real time!");
    } catch (err: any) {
      toast.error(err?.message || "Failed to save organization settings.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteWorkspace = () => {
    Alert.alert(
      "Delete Organization Workspace",
      `Are you sure you want to permanently delete "${organization?.churchName || "this organization"}" and all worker/attendance records? This cannot be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Forever",
          style: "destructive",
          onPress: async () => {
            setIsDeleting(true);
            try {
              await deleteAdminOrg();
              toast.info("Organization workspace deleted.");
              router.replace("/admin-onboarding" as any);
            } catch (err: any) {
              toast.error(err?.message || "Failed to delete workspace.");
            } finally {
              setIsDeleting(false);
            }
          },
        },
      ]
    );
  };

  const activeDaySched = getActiveDaySchedule(activeScheduleDay);

  return (
    <View style={styles.root}>
      {/* Organization Identity Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTag}>ORGANIZATION IDENTITY</Text>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>ORGANIZATION NAME</Text>
          <TextInput
            style={styles.input}
            value={churchName}
            onChangeText={setChurchName}
            placeholder="Organization Name"
          />
        </View>

        <View style={styles.fieldGroup}>
          <Text style={styles.label}>BRANCH / CAMPUS NAME</Text>
          <TextInput
            style={styles.input}
            value={branchName}
            onChangeText={setBranchName}
            placeholder="Main Campus"
          />
        </View>

        <View style={styles.codeBanner}>
          <View>
            <Text style={styles.label}>PAIRING CODE</Text>
            <Text style={styles.codeValue}>{organization?.churchCode || "N/A"}</Text>
          </View>
          <TouchableOpacity style={styles.copyBtn} onPress={handleCopyCode}>
            <Ionicons name="copy-outline" size={15} color={C.white} />
            <Text style={styles.copyBtnText}>COPY</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Workforce Units / Departments Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTag}>WORKFORCE UNITS ({departments.length})</Text>
        <View style={styles.addRow}>
          <TextInput
            style={[styles.input, { flex: 1 }]}
            placeholder="Add new unit or department..."
            placeholderTextColor={C.faint}
            value={newDept}
            onChangeText={setNewDept}
            onSubmitEditing={handleAddDept}
          />
          <TouchableOpacity style={styles.addBtn} onPress={handleAddDept}>
            <Ionicons name="add" size={20} color={C.white} />
          </TouchableOpacity>
        </View>

        <View style={styles.chipsWrap}>
          {departments.map((d) => (
            <View key={d} style={styles.deptChip}>
              <Text style={styles.deptChipText}>{d}</Text>
              {departments.length > 1 && (
                <TouchableOpacity
                  onPress={() =>
                    setDepartments((prev) => prev.filter((item) => item !== d))
                  }
                >
                  <Ionicons name="close-circle" size={16} color={C.accent} />
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>
      </View>

      {/* Service Days & Policy Card */}
      <View style={styles.card}>
        <Text style={styles.sectionTag}>SCHEDULE & ARRIVAL POLICY</Text>

        <View style={styles.daysRow}>
          {WEEK_DAYS.map((d) => {
            const active = serviceDays.includes(d.id);
            return (
              <TouchableOpacity
                key={d.id}
                style={[styles.dayPill, active && styles.dayPillActive]}
                onPress={() => toggleDay(d.id)}
              >
                <Text style={[styles.dayText, active && styles.dayTextActive]}>
                  {d.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={styles.segmentRow}>
          <TouchableOpacity
            style={[styles.segBtn, scheduleMode === "UNIFIED" && styles.segBtnActive]}
            onPress={() => setScheduleMode("UNIFIED")}
          >
            <Text
              style={[styles.segText, scheduleMode === "UNIFIED" && styles.segTextActive]}
            >
              Unified
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segBtn, scheduleMode === "PER_DAY" && styles.segBtnActive]}
            onPress={() => setScheduleMode("PER_DAY")}
          >
            <Text
              style={[styles.segText, scheduleMode === "PER_DAY" && styles.segTextActive]}
            >
              Per-Day
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.segBtn, scheduleMode === "MULTI_SHIFT" && styles.segBtnActive]}
            onPress={() => setScheduleMode("MULTI_SHIFT")}
          >
            <Text
              style={[styles.segText, scheduleMode === "MULTI_SHIFT" && styles.segTextActive]}
            >
              Multi-Shift
            </Text>
          </TouchableOpacity>
        </View>

        {scheduleMode === "MULTI_SHIFT" ? (
          <View style={{ gap: 10 }}>
            {shifts.map((sh) => {
              const isOvernight = sh.signOutTime < sh.arrivalCutoff;
              return (
                <View
                  key={sh.id}
                  style={{
                    padding: 12,
                    borderRadius: R.md,
                    borderWidth: 1,
                    borderColor: sh.enabled !== false ? C.accent : C.lineCard,
                    backgroundColor: C.cardAlt,
                    gap: 8,
                  }}
                >
                  <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 8 }}>
                      <TextInput
                        style={{
                          flex: 1,
                          fontSize: rf(13.5),
                          fontWeight: "700",
                          color: C.ink,
                          borderBottomWidth: 1,
                          borderBottomColor: C.lineCard,
                          paddingVertical: 2,
                        }}
                        value={sh.name}
                        onChangeText={(v) => updateShift(sh.id, { name: v })}
                        placeholder="Shift name"
                        placeholderTextColor={C.faint}
                      />
                      {isOvernight && (
                        <View style={{ backgroundColor: C.accentSoft, paddingHorizontal: 7, paddingVertical: 2, borderRadius: R.pill }}>
                          <Text style={{ fontSize: rf(9.5), fontWeight: "700", color: C.accent }}>OVERNIGHT</Text>
                        </View>
                      )}
                    </View>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                      {shifts.length > 1 && (
                        <TouchableOpacity onPress={() => removeShift(sh.id)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <Ionicons name="trash-outline" size={16} color={C.muted} />
                        </TouchableOpacity>
                      )}
                      <Switch
                        value={sh.enabled !== false}
                        onValueChange={(v) => updateShift(sh.id, { enabled: v })}
                        trackColor={{ false: C.line, true: C.accent }}
                      />
                    </View>
                  </View>
                  {sh.enabled !== false && (
                    <View style={{ flexDirection: "row", gap: 8 }}>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={styles.label}>OPEN</Text>
                        <TextInput
                          style={styles.input}
                          value={sh.arrivalCutoff}
                          onChangeText={(v) => updateShift(sh.id, { arrivalCutoff: v })}
                          placeholder="06:00"
                        />
                      </View>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={styles.label}>CUTOFF</Text>
                        <TextInput
                          style={styles.input}
                          value={sh.lateTolerance}
                          onChangeText={(v) => updateShift(sh.id, { lateTolerance: v })}
                          placeholder="06:30"
                        />
                      </View>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={styles.label}>SIGN OUT</Text>
                        <TextInput
                          style={styles.input}
                          value={sh.signOutTime}
                          onChangeText={(v) => updateShift(sh.id, { signOutTime: v })}
                          placeholder="14:00"
                        />
                      </View>
                    </View>
                  )}
                </View>
              );
            })}
            <TouchableOpacity
              style={{
                height: 44,
                borderRadius: R.md,
                borderWidth: 1,
                borderColor: C.lineCard,
                backgroundColor: C.card,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
              }}
              onPress={addCustomShift}
              activeOpacity={0.8}
            >
              <Ionicons name="add-circle-outline" size={16} color={C.ink} />
              <Text style={{ ...T.labelSm, color: C.ink, fontSize: rf(11) }}>ADD ANOTHER SHIFT</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>

        {scheduleMode === "PER_DAY" && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6 }}
          >
            {serviceDays.map((dayId) => {
              const name = WEEK_DAYS.find((w) => w.id === dayId)?.name || "";
              const active = activeScheduleDay === dayId;
              return (
                <TouchableOpacity
                  key={dayId}
                  style={[styles.dayChip, active && styles.dayChipActive]}
                  onPress={() => setActiveScheduleDay(dayId)}
                >
                  <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                    {name}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
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

        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>Allow Late Check-In</Text>
            <Text style={styles.switchSub}>Flag arrivals after cutoff as LATE</Text>
          </View>
          <Switch
            value={
              scheduleMode === "UNIFIED"
                ? allowLateSignIn
                : Boolean(activeDaySched.allowLateSignIn ?? true)
            }
            onValueChange={(v) =>
              scheduleMode === "UNIFIED"
                ? setAllowLateSignIn(v)
                : updateDaySchedule(activeScheduleDay, { allowLateSignIn: v })
            }
            trackColor={{ false: C.line, true: C.accent }}
          />
        </View>

        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>Mandatory Sign-Out</Text>
            <Text style={styles.switchSub}>Require workers to scan out at departure</Text>
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

        <TouchableOpacity
          style={styles.saveBtn}
          onPress={handleSaveChanges}
          disabled={isSaving}
          activeOpacity={0.85}
        >
          {isSaving ? (
            <ActivityIndicator size="small" color={C.white} />
          ) : (
            <>
              <Ionicons name="save-outline" size={18} color={C.white} />
              <Text style={styles.saveBtnText}>SAVE ORGANIZATION SETTINGS</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      {/* Danger Zone */}
      <View style={[styles.card, { borderColor: C.dangerSoft, borderWidth: 1 }]}>
        <Text style={[styles.sectionTag, { color: C.danger }]}>DANGER ZONE</Text>
        <Text style={styles.dangerSub}>
          Permanently delete this organization workspace, its attendance feed, and unbind all worker devices.
        </Text>
        <TouchableOpacity
          style={styles.deleteBtn}
          onPress={handleDeleteWorkspace}
          disabled={isDeleting}
          activeOpacity={0.85}
        >
          {isDeleting ? (
            <ActivityIndicator size="small" color={C.danger} />
          ) : (
            <>
              <Ionicons name="trash-outline" size={17} color={C.danger} />
              <Text style={styles.deleteBtnText}>DELETE ORGANIZATION WORKSPACE</Text>
            </>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { gap: 12 },
  card: { ...ui.card, padding: 15, gap: 12, ...shadow.card },
  sectionTag: { ...T.labelSm, color: C.accent },
  fieldGroup: { gap: 5 },
  label: { ...T.labelSm, fontSize: 10, color: C.muted },
  input: {
    height: 44,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.lineCard,
    borderRadius: R.md,
    paddingHorizontal: 12,
    fontSize: 14,
    fontWeight: "600",
    color: C.ink,
  },
  codeBanner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    padding: 12,
  },
  codeValue: {
    fontFamily: MONO,
    fontSize: 16,
    fontWeight: "800",
    color: C.ink,
    marginTop: 2,
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: C.ink,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: R.pill,
  },
  copyBtnText: { ...T.labelSm, color: C.white, fontSize: 10.5 },
  addRow: { flexDirection: "row", gap: 8 },
  addBtn: {
    width: 44,
    height: 44,
    borderRadius: R.md,
    backgroundColor: C.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  chipsWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  deptChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.accentSoft,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: R.pill,
  },
  deptChipText: { fontSize: 12.5, fontWeight: "700", color: C.ink },
  daysRow: { flexDirection: "row", gap: 5 },
  dayPill: {
    flex: 1,
    height: 36,
    borderRadius: R.sm,
    backgroundColor: C.cardAlt,
    borderWidth: 1,
    borderColor: C.lineCard,
    alignItems: "center",
    justifyContent: "center",
  },
  dayPillActive: { backgroundColor: C.ink, borderColor: C.ink },
  dayText: { fontSize: 11.5, fontWeight: "700", color: C.muted },
  dayTextActive: { color: C.white },
  segmentRow: {
    flexDirection: "row",
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    padding: 3,
    gap: 4,
  },
  segBtn: { flex: 1, paddingVertical: 8, borderRadius: R.sm, alignItems: "center" },
  segBtnActive: { backgroundColor: C.card, ...shadow.card },
  segText: { fontSize: 12.5, fontWeight: "600", color: C.muted },
  segTextActive: { color: C.ink, fontWeight: "800" },
  dayChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: R.pill,
    backgroundColor: C.cardAlt,
  },
  dayChipActive: { backgroundColor: C.ink },
  dayChipText: { fontSize: 12, fontWeight: "600", color: C.muted },
  dayChipTextActive: { color: C.white },
  row2: { flexDirection: "row", gap: 10 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: C.lineCard,
  },
  switchTitle: { ...T.heading, fontSize: 13.5 },
  switchSub: { ...T.caption, fontSize: 11.5 },
  saveBtn: {
    height: 48,
    borderRadius: R.md,
    backgroundColor: C.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: 4,
  },
  saveBtnText: { ...T.labelSm, color: C.white },
  dangerSub: { ...T.caption, fontSize: 12 },
  deleteBtn: {
    height: 46,
    borderRadius: R.md,
    backgroundColor: C.dangerSoft,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  deleteBtnText: { ...T.labelSm, color: C.danger },
});
