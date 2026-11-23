import React, { useState, useMemo } from "react";
import {
  Modal,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { C, R, S, T, rf } from "../constants/premium";

interface LocationPickerModalProps {
  visible: boolean;
  title: string;
  placeholder?: string;
  options: string[];
  selectedValue: string;
  allowCustomEntry?: boolean;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export const LocationPickerModal: React.FC<LocationPickerModalProps> = ({
  visible,
  title,
  placeholder = "Search...",
  options,
  selectedValue,
  allowCustomEntry = true,
  onSelect,
  onClose,
}) => {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((opt) => opt.toLowerCase().includes(q));
  }, [options, query]);

  const handleChoose = (val: string) => {
    setQuery("");
    onSelect(val);
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <View style={styles.header}>
          <Text style={styles.title}>{title}</Text>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Ionicons name="close" size={20} color={C.ink} />
          </TouchableOpacity>
        </View>

        <View style={styles.searchWrap}>
          <Ionicons name="search-outline" size={16} color={C.muted} />
          <TextInput
            style={styles.searchInput}
            placeholder={placeholder}
            placeholderTextColor={C.faint}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery("")}>
              <Ionicons name="close-circle" size={16} color={C.faint} />
            </TouchableOpacity>
          )}
        </View>

        <FlatList
          data={filtered}
          keyExtractor={(item) => item}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.listContent}
          renderItem={({ item }) => {
            const active = item.toLowerCase() === selectedValue.trim().toLowerCase();
            return (
              <TouchableOpacity
                style={[styles.row, active && styles.rowActive]}
                onPress={() => handleChoose(item)}
                activeOpacity={0.75}
              >
                <Text style={[styles.rowText, active && styles.rowTextActive]}>
                  {item}
                </Text>
                {active && (
                  <Ionicons name="checkmark-circle" size={18} color={C.accent} />
                )}
              </TouchableOpacity>
            );
          }}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              <Text style={styles.emptyText}>
                No matching items found.
              </Text>
              {allowCustomEntry && query.trim().length > 0 && (
                <TouchableOpacity
                  style={styles.useCustomBtn}
                  onPress={() => handleChoose(query.trim())}
                >
                  <Text style={styles.useCustomBtnText}>
                    Use "{query.trim()}"
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          }
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
  title: { ...T.title, fontSize: rf(17) },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: C.cardAlt,
    alignItems: "center",
    justifyContent: "center",
  },
  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    margin: S.screenX,
    marginBottom: 10,
    paddingHorizontal: 12,
    height: 44,
    backgroundColor: C.card,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  searchInput: {
    flex: 1,
    fontSize: rf(13.5),
    color: C.ink,
  },
  listContent: {
    paddingHorizontal: S.screenX,
    paddingBottom: Platform.OS === "ios" ? 32 : 20,
    gap: 6,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 13,
    backgroundColor: C.card,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.lineCard,
  },
  rowActive: {
    borderColor: C.accent,
    backgroundColor: C.accentSoft,
  },
  rowText: {
    fontSize: rf(14),
    fontWeight: "600",
    color: C.ink,
  },
  rowTextActive: {
    color: C.accent,
    fontWeight: "700",
  },
  emptyWrap: {
    paddingVertical: 32,
    alignItems: "center",
    gap: 12,
  },
  emptyText: {
    ...T.caption,
    fontSize: rf(13),
  },
  useCustomBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: R.pill,
    backgroundColor: C.ink,
  },
  useCustomBtnText: {
    color: C.white,
    fontSize: rf(13),
    fontWeight: "700",
  },
});
