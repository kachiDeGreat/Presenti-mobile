import React, { useState, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StyleSheet,
  Modal,
  Share,
  ActivityIndicator,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { addDoc, collection } from "firebase/firestore";
import { db } from "../config/firebase";
import { useToast } from "../context/ToastContext";
import { C, MONO, R, S, T, shadow, ui } from "../constants/premium";
import type { ChurchMember, Organization } from "../types";

export interface AuditAttendanceRecord {
  id: string;
  memberId: string;
  memberName: string;
  department: string;
  serviceDate: string;
  punchedAt: string;
  status: "ON_TIME" | "LATE";
  verificationMethod: "WIFI_BSSID" | "GEO_FALLBACK";
  bssidDetected?: string;
  signedOutAt?: string;
  signOutDisplayTime?: string;
}

interface AdminAuditsTabProps {
  organization: Organization | null;
  attendance: AuditAttendanceRecord[];
  members: ChurchMember[];
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export const AdminAuditsTab: React.FC<AdminAuditsTabProps> = ({
  organization,
  attendance,
  members,
}) => {
  const toast = useToast();
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth());
  const [scope, setScope] = useState<"MONTH" | "ALL">("MONTH");
  const [selectedDept, setSelectedDept] = useState("ALL");
  const [searchQuery, setSearchQuery] = useState("");

  // Manual Audit Log Modal
  const [showManualModal, setShowManualModal] = useState(false);
  const [manualMemberId, setManualMemberId] = useState("");
  const [manualDate, setManualDate] = useState(now.toISOString().split("T")[0]);
  const [manualTime, setManualTime] = useState("08:00");
  const [manualStatus, setManualStatus] = useState<"ON_TIME" | "LATE">("ON_TIME");
  const [manualMethod, setManualMethod] = useState<"WIFI_BSSID" | "GEO_FALLBACK">("WIFI_BSSID");
  const [isSavingManual, setIsSavingManual] = useState(false);

  const departments = useMemo(() => {
    const set = new Set<string>(organization?.departments || []);
    attendance.forEach((a) => {
      if (a.department) set.add(a.department);
    });
    return ["ALL", ...Array.from(set)];
  }, [organization?.departments, attendance]);

  const filteredRecords = useMemo(() => {
    return attendance.filter((rec) => {
      if (scope === "MONTH") {
        const d = new Date(rec.punchedAt || rec.serviceDate);
        if (isNaN(d.getTime())) return false;
        if (d.getFullYear() !== selectedYear || d.getMonth() !== selectedMonth) {
          return false;
        }
      }
      if (selectedDept !== "ALL" && rec.department !== selectedDept) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const hit =
          (rec.memberName || "").toLowerCase().includes(q) ||
          (rec.department || "").toLowerCase().includes(q) ||
          (rec.serviceDate || "").toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [attendance, scope, selectedYear, selectedMonth, selectedDept, searchQuery]);

  const stats = useMemo(() => {
    const total = filteredRecords.length;
    const onTime = filteredRecords.filter((r) => r.status !== "LATE").length;
    const late = filteredRecords.filter((r) => r.status === "LATE").length;
    const signedOut = filteredRecords.filter((r) => Boolean(r.signedOutAt)).length;
    const uniqueWorkers = new Set(filteredRecords.map((r) => r.memberId)).size;
    const rate = total > 0 ? Math.round((onTime / total) * 100) : 0;
    return { total, onTime, late, signedOut, uniqueWorkers, rate };
  }, [filteredRecords]);

  const stepMonth = (delta: number) => {
    let m = selectedMonth + delta;
    let y = selectedYear;
    if (m < 0) {
      m = 11;
      y -= 1;
    } else if (m > 11) {
      m = 0;
      y += 1;
    }
    setSelectedMonth(m);
    setSelectedYear(y);
  };

  const buildCsvText = () => {
    const header = "Member Name,Department,Date,Time,Status,Method,Sign Out";
    const rows = filteredRecords.map((r) => {
      const timeStr = r.punchedAt
        ? new Date(r.punchedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      const outStr = r.signOutDisplayTime || (r.signedOutAt ? "Signed Out" : "—");
      return [
        `"${(r.memberName || "").replace(/"/g, '""')}"`,
        `"${(r.department || "General").replace(/"/g, '""')}"`,
        r.serviceDate || "",
        timeStr,
        r.status || "ON_TIME",
        r.verificationMethod || "GEO_FALLBACK",
        outStr,
      ].join(",");
    });
    return [header, ...rows].join("\n");
  };

  const handleExportCsv = async () => {
    if (filteredRecords.length === 0) {
      toast.warn("No audit records to export for this filter.");
      return;
    }
    const csv = buildCsvText();
    await Clipboard.setStringAsync(csv);
    try {
      await Share.share({
        title: `${organization?.churchName || "Presenti"} Attendance Audit`,
        message: csv,
      });
    } catch {
      toast.success("CSV report copied to clipboard!");
    }
  };

  const handleSaveManualLog = async () => {
    if (!organization?.id) return;
    const target = members.find((m) => m.id === manualMemberId) || members[0];
    if (!target) {
      toast.warn("No registered worker selected.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(manualDate.trim())) {
      toast.warn("Use YYYY-MM-DD format for date.");
      return;
    }
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(manualTime.trim())) {
      toast.warn("Use 24h HH:MM format for time (e.g. 08:00).");
      return;
    }

    setIsSavingManual(true);
    try {
      const iso = `${manualDate.trim()}T${manualTime.trim()}:00.000Z`;
      await addDoc(collection(db, "churches", organization.id, "attendance"), {
        memberId: target.id,
        memberName: target.fullName,
        department: target.department || "General",
        serviceDate: manualDate.trim(),
        timestamp: iso,
        punchedAt: iso,
        syncedAt: new Date().toISOString(),
        verificationMethod: manualMethod,
        status: manualStatus,
        deviceId: "ADMIN_AUDIT_OVERRIDE",
        manualOverride: true,
      });
      setShowManualModal(false);
      toast.success(`Logged attendance audit for ${target.fullName}.`);
    } catch (err: any) {
      toast.error(err?.message || "Failed to save manual audit entry.");
    } finally {
      setIsSavingManual(false);
    }
  };

  return (
    <View style={styles.root}>
      {/* Header Banner */}
      <View style={styles.heroCard}>
        <View style={styles.heroTopRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.tag}>ORGANIZATION AUDITS & REPORTS</Text>
            <Text style={styles.title}>Compliance & Export</Text>
          </View>
          <View style={styles.heroBtnRow}>
            <TouchableOpacity
              style={styles.iconActionBtn}
              onPress={() => {
                if (members.length > 0 && !manualMemberId) {
                  setManualMemberId(members[0].id);
                }
                setShowManualModal(true);
              }}
              activeOpacity={0.8}
            >
              <Ionicons name="add-circle-outline" size={18} color={C.ink} />
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.iconActionBtn, { backgroundColor: C.ink }]}
              onPress={handleExportCsv}
              activeOpacity={0.8}
            >
              <Ionicons name="download-outline" size={18} color={C.white} />
            </TouchableOpacity>
          </View>
        </View>

        {/* Scope & Month Switcher */}
        <View style={styles.scopeRow}>
          <View style={styles.scopeToggle}>
            <TouchableOpacity
              style={[styles.scopeBtn, scope === "MONTH" && styles.scopeBtnActive]}
              onPress={() => setScope("MONTH")}
            >
              <Text style={[styles.scopeText, scope === "MONTH" && styles.scopeTextActive]}>
                MONTHLY
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.scopeBtn, scope === "ALL" && styles.scopeBtnActive]}
              onPress={() => setScope("ALL")}
            >
              <Text style={[styles.scopeText, scope === "ALL" && styles.scopeTextActive]}>
                ALL TIME
              </Text>
            </TouchableOpacity>
          </View>

          {scope === "MONTH" && (
            <View style={styles.monthStepper}>
              <TouchableOpacity onPress={() => stepMonth(-1)} style={styles.stepBtn}>
                <Ionicons name="chevron-back" size={16} color={C.ink} />
              </TouchableOpacity>
              <Text style={styles.monthLabel}>
                {MONTH_NAMES[selectedMonth].slice(0, 3)} {selectedYear}
              </Text>
              <TouchableOpacity onPress={() => stepMonth(1)} style={styles.stepBtn}>
                <Ionicons name="chevron-forward" size={16} color={C.ink} />
              </TouchableOpacity>
            </View>
          )}
        </View>
      </View>

      {/* Audit Metrics Grid */}
      <View style={styles.kpiRow}>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>TOTAL PUNCHES</Text>
          <Text style={[styles.kpiValue, { color: C.accent }]}>{stats.total}</Text>
          <Text style={styles.kpiSub}>{stats.uniqueWorkers} active staff</Text>
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>ON-TIME RATE</Text>
          <Text style={[styles.kpiValue, { color: C.success }]}>{stats.rate}%</Text>
          <Text style={styles.kpiSub}>{stats.onTime} punctual</Text>
        </View>
        <View style={styles.kpiCard}>
          <Text style={styles.kpiLabel}>LATE / OUT</Text>
          <Text style={[styles.kpiValue, { color: stats.late > 0 ? C.warn : C.ink }]}>
            {stats.late}
          </Text>
          <Text style={styles.kpiSub}>{stats.signedOut} signed out</Text>
        </View>
      </View>

      {/* Search & Department Filter */}
      <View style={styles.searchBox}>
        <Ionicons name="search-outline" size={16} color={C.muted} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search name, dept, or YYYY-MM-DD..."
          placeholderTextColor={C.faint}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery("")}>
            <Ionicons name="close-circle" size={16} color={C.faint} />
          </TouchableOpacity>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 6, paddingVertical: 2 }}
      >
        {departments.map((dept) => {
          const active = selectedDept === dept;
          return (
            <TouchableOpacity
              key={dept}
              style={[styles.filterChip, active && styles.filterChipActive]}
              onPress={() => setSelectedDept(dept)}
            >
              <Text style={[styles.filterChipText, active && styles.filterChipTextActive]}>
                {dept}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* Audit Records List */}
      {filteredRecords.length === 0 ? (
        <View style={styles.emptyCard}>
          <Ionicons name="document-text-outline" size={32} color={C.faint} />
          <Text style={styles.emptyTitle}>No Audit Records Found</Text>
          <Text style={styles.emptySub}>
            Adjust your month/department filter or tap + above to log a manual audit entry.
          </Text>
        </View>
      ) : (
        <View style={{ gap: 10 }}>
          {filteredRecords.slice(0, 60).map((rec) => {
            const isLate = rec.status === "LATE";
            const timeStr = rec.punchedAt
              ? new Date(rec.punchedAt).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "";
            return (
              <View key={rec.id} style={styles.recordCard}>
                <View style={styles.recordTop}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.recordName}>{rec.memberName}</Text>
                    <Text style={styles.recordMeta}>
                      {rec.department || "General"} • {rec.serviceDate} • {timeStr}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.statusBadge,
                      { backgroundColor: isLate ? C.warnSoft : C.successSoft },
                    ]}
                  >
                    <Text
                      style={[
                        styles.statusBadgeText,
                        { color: isLate ? C.warn : C.success },
                      ]}
                    >
                      {isLate ? "LATE" : "ON TIME"}
                    </Text>
                  </View>
                </View>

                <View style={styles.recordBottom}>
                  <View style={styles.methodPill}>
                    <Ionicons
                      name={rec.verificationMethod === "WIFI_BSSID" ? "wifi" : "location"}
                      size={12}
                      color={C.accent}
                    />
                    <Text style={styles.methodText}>
                      {rec.verificationMethod === "WIFI_BSSID" ? "Wi-Fi Anchor" : "GPS Geofence"}
                    </Text>
                  </View>
                  <Text style={styles.signOutInfo}>
                    {rec.signedOutAt
                      ? `Out: ${rec.signOutDisplayTime || "Recorded"}`
                      : "No sign-out"}
                  </Text>
                </View>
              </View>
            );
          })}
        </View>
      )}

      {/* Manual Audit Entry Modal */}
      <Modal
        visible={showManualModal}
        transparent
        animationType="slide"
        onRequestClose={() => setShowManualModal(false)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Manual Attendance Audit</Text>
              <TouchableOpacity onPress={() => setShowManualModal(false)}>
                <Ionicons name="close" size={22} color={C.ink} />
              </TouchableOpacity>
            </View>

            <Text style={styles.inputLabel}>SELECT WORKER</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, marginBottom: 10 }}
            >
              {members.map((m) => {
                const active = (manualMemberId || members[0]?.id) === m.id;
                return (
                  <TouchableOpacity
                    key={m.id}
                    style={[styles.filterChip, active && styles.filterChipActive]}
                    onPress={() => setManualMemberId(m.id)}
                  >
                    <Text
                      style={[styles.filterChipText, active && styles.filterChipTextActive]}
                    >
                      {m.fullName}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={{ flexDirection: "row", gap: 10 }}>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.inputLabel}>DATE (YYYY-MM-DD)</Text>
                <TextInput
                  style={styles.modalInput}
                  value={manualDate}
                  onChangeText={setManualDate}
                  placeholder="2026-11-20"
                />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={styles.inputLabel}>TIME (24H HH:MM)</Text>
                <TextInput
                  style={styles.modalInput}
                  value={manualTime}
                  onChangeText={setManualTime}
                  placeholder="08:00"
                />
              </View>
            </View>

            <View style={{ flexDirection: "row", gap: 8 }}>
              {(["ON_TIME", "LATE"] as const).map((st) => (
                <TouchableOpacity
                  key={st}
                  style={[
                    styles.filterChip,
                    { flex: 1, alignItems: "center" },
                    manualStatus === st && styles.filterChipActive,
                  ]}
                  onPress={() => setManualStatus(st)}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      manualStatus === st && styles.filterChipTextActive,
                    ]}
                  >
                    {st === "ON_TIME" ? "ON TIME" : "LATE"}
                  </Text>
                </TouchableOpacity>
              ))}
              {(["WIFI_BSSID", "GEO_FALLBACK"] as const).map((mt) => (
                <TouchableOpacity
                  key={mt}
                  style={[
                    styles.filterChip,
                    { flex: 1, alignItems: "center" },
                    manualMethod === mt && styles.filterChipActive,
                  ]}
                  onPress={() => setManualMethod(mt)}
                >
                  <Text
                    style={[
                      styles.filterChipText,
                      manualMethod === mt && styles.filterChipTextActive,
                    ]}
                  >
                    {mt === "WIFI_BSSID" ? "WI-FI" : "GPS"}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <TouchableOpacity
              style={styles.saveModalBtn}
              onPress={handleSaveManualLog}
              disabled={isSavingManual}
            >
              {isSavingManual ? (
                <ActivityIndicator size="small" color={C.white} />
              ) : (
                <Text style={styles.saveModalBtnText}>SAVE AUDIT ENTRY</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  root: { gap: 12 },
  heroCard: { ...ui.card, padding: 14, gap: 12, ...shadow.card },
  heroTopRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  tag: { ...T.labelSm, fontSize: 10, color: C.accent },
  title: { ...T.title, fontSize: 16.5, marginTop: 2 },
  heroBtnRow: { flexDirection: "row", gap: 8 },
  iconActionBtn: {
    width: 36,
    height: 36,
    borderRadius: R.md,
    backgroundColor: C.cardAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  scopeRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  scopeToggle: {
    flexDirection: "row",
    backgroundColor: C.cardAlt,
    borderRadius: R.pill,
    padding: 3,
  },
  scopeBtn: { paddingHorizontal: 11, paddingVertical: 5, borderRadius: R.pill },
  scopeBtnActive: { backgroundColor: C.ink },
  scopeText: { ...T.labelSm, fontSize: 10, color: C.muted },
  scopeTextActive: { color: C.white },
  monthStepper: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.cardAlt,
    borderRadius: R.pill,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  stepBtn: { padding: 4 },
  monthLabel: { fontSize: 12, fontWeight: "700", color: C.ink, minWidth: 62, textAlign: "center" },
  kpiRow: { flexDirection: "row", gap: 8 },
  kpiCard: { ...ui.card, flex: 1, padding: 10, ...shadow.card },
  kpiLabel: { ...T.labelSm, fontSize: 9, color: C.muted },
  kpiValue: { fontSize: 20, fontWeight: "900", marginTop: 3 },
  kpiSub: { ...T.caption, fontSize: 10.5, marginTop: 2 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.card,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.lineCard,
    paddingHorizontal: 12,
    height: 42,
  },
  searchInput: { flex: 1, fontSize: 12, color: C.ink },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: R.pill,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  filterChipActive: { backgroundColor: C.ink, borderColor: C.ink },
  filterChipText: { fontSize: 12, fontWeight: "600", color: C.ink2 },
  filterChipTextActive: { color: C.white },
  emptyCard: { ...ui.card, padding: 28, alignItems: "center", gap: 8 },
  emptyTitle: { ...T.heading, fontSize: 15 },
  emptySub: { ...T.caption, textAlign: "center" },
  recordCard: { ...ui.card, padding: 13, gap: 8, ...shadow.card },
  recordTop: { flexDirection: "row", alignItems: "center", gap: 10 },
  recordName: { ...T.heading, fontSize: 14.5 },
  recordMeta: { ...T.caption, fontSize: 12, marginTop: 2 },
  statusBadge: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: R.pill },
  statusBadgeText: { ...T.labelSm, fontSize: 9.5 },
  recordBottom: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: C.lineCard,
    paddingTop: 8,
  },
  methodPill: { flexDirection: "row", alignItems: "center", gap: 4 },
  methodText: { fontSize: 11.5, fontWeight: "600", color: C.ink2 },
  signOutInfo: { fontSize: 11.5, color: C.muted, fontWeight: "600" },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(20, 39, 72, 0.45)",
    justifyContent: "flex-end",
  },
  modalCard: {
    backgroundColor: C.card,
    borderTopLeftRadius: R.xl,
    borderTopRightRadius: R.xl,
    padding: 20,
    gap: 12,
  },
  modalHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  modalTitle: { ...T.title, fontSize: 18 },
  inputLabel: { ...T.labelSm, color: C.muted },
  modalInput: {
    height: 44,
    backgroundColor: C.cardAlt,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.lineCard,
    paddingHorizontal: 12,
    fontSize: 14,
    color: C.ink,
    fontWeight: "600",
    fontFamily: MONO,
  },
  saveModalBtn: {
    height: 48,
    borderRadius: R.md,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  saveModalBtnText: { ...T.labelSm, color: C.white },
});
