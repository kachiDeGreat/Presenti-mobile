import React, { useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Switch,
  StyleSheet,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { C, R, T, rf } from "../constants/premium";
import { TimePickerModal } from "./TimePickerModal";
import type { ShiftSchedule } from "../types";

const DAY_NAMES: Record<number, string> = {
  0: "Sun",
  1: "Mon",
  2: "Tue",
  3: "Wed",
  4: "Thu",
  5: "Fri",
  6: "Sat",
};

interface ShiftScheduleEditorProps {
  shifts: ShiftSchedule[];
  serviceDays: number[];
  onChangeShifts: (next: ShiftSchedule[]) => void;
}

export const ShiftScheduleEditor: React.FC<ShiftScheduleEditorProps> = ({
  shifts,
  serviceDays,
  onChangeShifts,
}) => {
  const [varyByDay, setVaryByDay] = useState(() =>
    shifts.some((s) => s.dayOverrides && Object.keys(s.dayOverrides).length > 0)
  );
  const [activeDay, setActiveDay] = useState<number>(serviceDays[0] ?? 1);
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [timePicker, setTimePicker] = useState<{
    shiftId: string;
    field: "arrivalCutoff" | "lateTolerance" | "signOutTime";
    title: string;
    value: string;
  } | null>(null);

  const updateShift = (shiftId: string, patch: Partial<ShiftSchedule>) => {
    onChangeShifts(
      shifts.map((s) => (s.id === shiftId ? { ...s, ...patch } : s))
    );
  };

  const getShiftTimes = (sh: ShiftSchedule) => {
    if (varyByDay && sh.dayOverrides?.[activeDay]) {
      const ov = sh.dayOverrides[activeDay];
      return {
        arrivalCutoff: ov.arrivalCutoff || sh.arrivalCutoff,
        lateTolerance: ov.lateTolerance || sh.lateTolerance,
        signOutTime: ov.signOutTime || sh.signOutTime,
      };
    }
    return {
      arrivalCutoff: sh.arrivalCutoff,
      lateTolerance: sh.lateTolerance,
      signOutTime: sh.signOutTime,
    };
  };

  const setShiftTime = (
    shiftId: string,
    field: "arrivalCutoff" | "lateTolerance" | "signOutTime",
    hhmm: string
  ) => {
    if (!varyByDay) {
      updateShift(shiftId, { [field]: hhmm });
      return;
    }
    onChangeShifts(
      shifts.map((s) => {
        if (s.id !== shiftId) return s;
        const prevOv = s.dayOverrides || {};
        return {
          ...s,
          dayOverrides: {
            ...prevOv,
            [activeDay]: {
              ...(prevOv[activeDay] || {}),
              [field]: hhmm,
            },
          },
        };
      })
    );
  };

  const addCustomShift = () => {
    const idx = shifts.length + 1;
    const newId = `SHIFT_${Date.now().toString(36)}`;
    onChangeShifts([
      ...shifts,
      {
        id: newId,
        name: `Shift ${idx}`,
        arrivalCutoff: "09:00",
        lateTolerance: "09:30",
        signOutTime: "17:00",
        allowLateSignIn: true,
        enableSignOut: true,
        enabled: true,
      },
    ]);
    setEditingNameId(newId);
  };

  const removeShift = (shiftId: string) => {
    if (shifts.length <= 1) return;
    onChangeShifts(shifts.filter((s) => s.id !== shiftId));
  };

  const daysToShow = serviceDays.length > 0 ? serviceDays : [1, 2, 3, 4, 5];

  return (
    <View style={styles.container}>
      {/* Compact Header: All Days Same vs Vary by Day */}
      <View style={styles.modeBar}>
        <TouchableOpacity
          style={[styles.modePill, !varyByDay && styles.modePillActive]}
          onPress={() => setVaryByDay(false)}
          activeOpacity={0.8}
        >
          <Text style={[styles.modePillText, !varyByDay && styles.modePillTextActive]}>
            Same Daily
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.modePill, varyByDay && styles.modePillActive]}
          onPress={() => setVaryByDay(true)}
          activeOpacity={0.8}
        >
          <Text style={[styles.modePillText, varyByDay && styles.modePillTextActive]}>
            Vary by Day
          </Text>
        </TouchableOpacity>
      </View>

      {varyByDay && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6 }}
        >
          {daysToShow.map((dId) => {
            const active = activeDay === dId;
            return (
              <TouchableOpacity
                key={dId}
                style={[styles.dayChip, active && styles.dayChipActive]}
                onPress={() => setActiveDay(dId)}
              >
                <Text style={[styles.dayChipText, active && styles.dayChipTextActive]}>
                  {DAY_NAMES[dId] || `D${dId}`}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Shift Cards */}
      {shifts.map((sh) => {
        const times = getShiftTimes(sh);
        const isOvernight = times.signOutTime < times.arrivalCutoff;
        const isEditingName = editingNameId === sh.id;
        const requireSignOut = sh.enableSignOut !== false;

        return (
          <View
            key={sh.id}
            style={[
              styles.shiftCard,
              sh.enabled === false && { opacity: 0.6, borderColor: C.lineCard },
            ]}
          >
            {/* Header Row */}
            <View style={styles.shiftHeader}>
              <View style={styles.shiftTitleWrap}>
                {isEditingName ? (
                  <TextInput
                    style={styles.nameInput}
                    value={sh.name}
                    onChangeText={(v) => updateShift(sh.id, { name: v })}
                    onBlur={() => setEditingNameId(null)}
                    autoFocus
                    placeholder="Shift name"
                    placeholderTextColor={C.faint}
                  />
                ) : (
                  <TouchableOpacity
                    style={styles.nameBtn}
                    onPress={() => setEditingNameId(sh.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.shiftName} numberOfLines={1}>
                      {sh.name || "Unnamed Shift"}
                    </Text>
                    <Ionicons name="create-outline" size={14} color={C.accent} />
                  </TouchableOpacity>
                )}

                {isOvernight && (
                  <View style={styles.overnightBadge}>
                    <Text style={styles.overnightText}>OVERNIGHT</Text>
                  </View>
                )}
              </View>

              <View style={styles.headerActions}>
                {shifts.length > 1 && (
                  <TouchableOpacity
                    onPress={() => removeShift(sh.id)}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
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

            {/* Tappable Time Dropdowns */}
            {sh.enabled !== false && (
              <>
                <View style={styles.timeRow}>
                  <TouchableOpacity
                    style={styles.timeBox}
                    onPress={() =>
                      setTimePicker({
                        shiftId: sh.id,
                        field: "arrivalCutoff",
                        title: `${sh.name} — Open Time`,
                        value: times.arrivalCutoff,
                      })
                    }
                    activeOpacity={0.75}
                  >
                    <Text style={styles.timeLabel}>OPEN</Text>
                    <View style={styles.timeValueRow}>
                      <Text style={styles.timeValue}>{times.arrivalCutoff}</Text>
                      <Ionicons name="chevron-down" size={13} color={C.muted} />
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.timeBox}
                    onPress={() =>
                      setTimePicker({
                        shiftId: sh.id,
                        field: "lateTolerance",
                        title: `${sh.name} — Late Cutoff`,
                        value: times.lateTolerance,
                      })
                    }
                    activeOpacity={0.75}
                  >
                    <Text style={styles.timeLabel}>CUTOFF</Text>
                    <View style={styles.timeValueRow}>
                      <Text style={styles.timeValue}>{times.lateTolerance}</Text>
                      <Ionicons name="chevron-down" size={13} color={C.muted} />
                    </View>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[styles.timeBox, !requireSignOut && { opacity: 0.45 }]}
                    disabled={!requireSignOut}
                    onPress={() =>
                      setTimePicker({
                        shiftId: sh.id,
                        field: "signOutTime",
                        title: `${sh.name} — Sign Out Time`,
                        value: times.signOutTime,
                      })
                    }
                    activeOpacity={0.75}
                  >
                    <Text style={styles.timeLabel}>SIGN OUT</Text>
                    <View style={styles.timeValueRow}>
                      <Text style={styles.timeValue}>
                        {requireSignOut ? times.signOutTime : "Off"}
                      </Text>
                      <Ionicons name="chevron-down" size={13} color={C.muted} />
                    </View>
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={styles.signOutToggleRow}
                  onPress={() =>
                    updateShift(sh.id, { enableSignOut: !requireSignOut })
                  }
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name={requireSignOut ? "checkbox" : "square-outline"}
                    size={15}
                    color={requireSignOut ? C.accent : C.muted}
                  />
                  <Text style={styles.signOutToggleText}>
                    Require Sign-Out at shift end
                  </Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        );
      })}

      {/* Add Another Shift Button */}
      <TouchableOpacity
        style={styles.addShiftBtn}
        onPress={addCustomShift}
        activeOpacity={0.8}
      >
        <Ionicons name="add-circle" size={17} color={C.accent} />
        <Text style={styles.addShiftText}>ADD ANOTHER SHIFT</Text>
      </TouchableOpacity>

      <TimePickerModal
        visible={timePicker !== null}
        title={timePicker?.title || "Select Time"}
        selectedTime={timePicker?.value || "08:00"}
        onSelect={(hhmm) => {
          if (timePicker) {
            setShiftTime(timePicker.shiftId, timePicker.field, hhmm);
          }
        }}
        onClose={() => setTimePicker(null)}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { gap: 10 },
  modeBar: {
    flexDirection: "row",
    backgroundColor: C.cardAlt,
    borderRadius: R.pill,
    padding: 3,
    alignSelf: "flex-start",
    gap: 4,
  },
  modePill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: R.pill,
  },
  modePillActive: {
    backgroundColor: C.ink,
  },
  modePillText: {
    fontSize: rf(11.5),
    fontWeight: "700",
    color: C.muted,
  },
  modePillTextActive: {
    color: C.white,
  },
  dayChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: R.pill,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  dayChipActive: {
    backgroundColor: C.accentSoft,
    borderColor: C.accent,
  },
  dayChipText: {
    fontSize: rf(11.5),
    fontWeight: "700",
    color: C.muted,
  },
  dayChipTextActive: {
    color: C.accent,
  },
  shiftCard: {
    padding: 12,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.accent,
    backgroundColor: C.cardAlt,
    gap: 8,
  },
  shiftHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  shiftTitleWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  nameBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    flexShrink: 1,
  },
  shiftName: {
    fontSize: rf(13.5),
    fontWeight: "800",
    color: C.ink,
  },
  nameInput: {
    flex: 1,
    fontSize: rf(13.5),
    fontWeight: "700",
    color: C.ink,
    borderBottomWidth: 1,
    borderBottomColor: C.accent,
    paddingVertical: 2,
  },
  overnightBadge: {
    backgroundColor: C.accentSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: R.pill,
  },
  overnightText: {
    fontSize: rf(9),
    fontWeight: "800",
    color: C.accent,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  timeRow: {
    flexDirection: "row",
    gap: 6,
  },
  timeBox: {
    flex: 1,
    backgroundColor: C.card,
    borderRadius: R.sm,
    borderWidth: 1,
    borderColor: C.lineCard,
    paddingHorizontal: 9,
    paddingVertical: 7,
    gap: 2,
  },
  timeLabel: {
    ...T.labelSm,
    fontSize: rf(9),
    color: C.muted,
  },
  timeValueRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  timeValue: {
    fontSize: rf(13),
    fontWeight: "800",
    color: C.ink,
  },
  signOutToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingTop: 2,
  },
  signOutToggleText: {
    fontSize: rf(11.5),
    fontWeight: "600",
    color: C.ink2,
  },
  addShiftBtn: {
    height: 44,
    borderRadius: R.md,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: C.accent,
    backgroundColor: C.accentSoft,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  addShiftText: {
    ...T.labelSm,
    fontSize: rf(11),
    color: C.accent,
  },
});
