import React, { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  FlatList,
  TextInput,
  StyleSheet,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { C, R, S, T, rf } from "../constants/premium";
import { format12Hour } from "../utils/timePolicy";

interface TimePickerModalProps {
  visible: boolean;
  title: string;
  selectedTime: string;
  onSelect: (timeHHMM: string) => void;
  onClose: () => void;
}

const TIME_SLOTS: string[] = [];
for (let h = 0; h < 24; h++) {
  for (const m of [0, 30]) {
    TIME_SLOTS.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }
}

export const TimePickerModal: React.FC<TimePickerModalProps> = ({
  visible,
  title,
  selectedTime,
  onSelect,
  onClose,
}) => {
  const [customTime, setCustomTime] = useState("");

  const slots = useMemo(() => TIME_SLOTS, []);

  const handleChoose = (hhmm: string) => {
    setCustomTime("");
    onSelect(hhmm);
    onClose();
  };

  const isValidCustom = /^([01]\d|2[0-3]):([0-5]\d)$/.test(customTime.trim());

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={20} color={C.ink} />
          </TouchableOpacity>
        </View>

        <View style={styles.customRow}>
          <TextInput
            style={styles.customInput}
            placeholder="Custom 24h (e.g. 06:15)"
            placeholderTextColor={C.faint}
            value={customTime}
            onChangeText={setCustomTime}
            maxLength={5}
            keyboardType="numbers-and-punctuation"
          />
          <TouchableOpacity
            style={[styles.customBtn, !isValidCustom && { opacity: 0.45 }]}
            disabled={!isValidCustom}
            onPress={() => handleChoose(customTime.trim())}
          >
            <Text style={styles.customBtnText}>USE</Text>
          </TouchableOpacity>
        </View>

        <FlatList
          data={slots}
          keyExtractor={(item) => item}
          numColumns={2}
          columnWrapperStyle={{ gap: 8 }}
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const active = item === selectedTime;
            return (
              <TouchableOpacity
                style={[styles.slotCard, active && styles.slotCardActive]}
                onPress={() => handleChoose(item)}
                activeOpacity={0.75}
              >
                <Text style={[styles.slot24, active && styles.slot24Active]}>
                  {item}
                </Text>
                <Text style={[styles.slot12, active && styles.slot12Active]}>
                  {format12Hour(item)}
                </Text>
              </TouchableOpacity>
            );
          }}
        />
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: C.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: S.screenX,
    paddingVertical: 14,
    backgroundColor: C.card,
    borderBottomWidth: 1,
    borderBottomColor: C.lineCard,
  },
  title: { ...T.title, fontSize: rf(16.5) },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.cardAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  customRow: {
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: S.screenX,
    paddingVertical: 12,
  },
  customInput: {
    flex: 1,
    height: 42,
    backgroundColor: C.card,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.lineCard,
    paddingHorizontal: 12,
    fontSize: rf(13.5),
    color: C.ink,
    fontWeight: "600",
  },
  customBtn: {
    height: 42,
    paddingHorizontal: 16,
    borderRadius: R.md,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  customBtnText: {
    ...T.labelSm,
    color: C.white,
    fontSize: rf(11),
  },
  listContent: {
    paddingHorizontal: S.screenX,
    paddingBottom: Platform.OS === "ios" ? 32 : 24,
    gap: 8,
  },
  slotCard: {
    flex: 1,
    paddingVertical: 11,
    paddingHorizontal: 12,
    borderRadius: R.md,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  slotCardActive: {
    backgroundColor: C.accentSoft,
    borderColor: C.accent,
  },
  slot24: {
    fontSize: rf(14),
    fontWeight: "800",
    color: C.ink,
  },
  slot24Active: {
    color: C.accent,
  },
  slot12: {
    fontSize: rf(11.5),
    color: C.muted,
    fontWeight: "600",
  },
  slot12Active: {
    color: C.accent,
  },
});
