import React, { useState, useRef, useEffect } from "react";
import {
  View,
  Text,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { useToast } from "../context/ToastContext";
import {
  askPresentiMobileAI,
  generateMobileBriefing,
  type MobileChatMessage,
  type MobileAIContext,
} from "../services/geminiService";

interface AskPresentiChatModalProps {
  visible: boolean;
  onClose: () => void;
  context: MobileAIContext;
}

const QUICK_CHIPS = [
  "Who is late today?",
  "Department turnout",
  "Who hasn't checked in?",
];

export const AskPresentiChatModal: React.FC<AskPresentiChatModalProps> = ({
  visible,
  onClose,
  context,
}) => {
  const toast = useToast();
  const [messages, setMessages] = useState<MobileChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  useEffect(() => {
    if (visible) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages, isLoading, visible]);

  const handleBriefing = async () => {
    if (isLoading) return;
    const nowLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setMessages((prev) => [
      ...prev,
      { role: "user", content: "Generate today's Executive Briefing.", timestamp: nowLabel },
    ]);
    setIsLoading(true);
    try {
      const reply = await generateMobileBriefing(context);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: reply,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } catch (err: any) {
      const msg = err?.message || "Unable to reach Gemini AI.";
      toast.error(msg);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${msg}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSend = async (overrideText?: string) => {
    const q = (overrideText ?? input).trim();
    if (!q || isLoading) return;
    if (!overrideText) setInput("");

    const nowLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const userMsg: MobileChatMessage = { role: "user", content: q, timestamp: nowLabel };
    const prevMsgs = messages;
    setMessages((prev) => [...prev, userMsg]);
    setIsLoading(true);

    try {
      const reply = await askPresentiMobileAI(q, context, prevMsgs);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: reply,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } catch (err: any) {
      const msg = err?.message || "Unable to reach Gemini AI.";
      toast.error(msg);
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `Error: ${msg}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopy = async (text: string, idx: number) => {
    await Clipboard.setStringAsync(text);
    setCopiedIdx(idx);
    toast.success("Copied for WhatsApp / Email!");
    setTimeout(() => setCopiedIdx(null), 2000);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <View style={styles.sheet}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={styles.aiIconBox}>
                <Ionicons name="sparkles" size={16} color="#ffffff" />
              </View>
              <View>
                <Text style={styles.headerTitle}>Ask Presenti AI</Text>
                <Text style={styles.headerSub}>
                  GEMINI INTELLIGENCE • {context.totalCheckedIn} PUNCHES
                </Text>
              </View>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
              <Ionicons name="close" size={20} color="#f2f1ee" />
            </TouchableOpacity>
          </View>

          {/* Quick Prompt Chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipsScroll}
            contentContainerStyle={styles.chipsContent}
          >
            <TouchableOpacity
              style={styles.chipPrimary}
              onPress={handleBriefing}
              disabled={isLoading}
              activeOpacity={0.8}
            >
              <Ionicons name="document-text-outline" size={13} color="#ffffff" />
              <Text style={styles.chipPrimaryText}>Executive Briefing</Text>
            </TouchableOpacity>

            {QUICK_CHIPS.map((chip) => (
              <TouchableOpacity
                key={chip}
                style={styles.chip}
                onPress={() => handleSend(chip)}
                disabled={isLoading}
                activeOpacity={0.75}
              >
                <Text style={styles.chipText}>{chip}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Messages Feed */}
          <ScrollView
            ref={scrollRef}
            style={styles.messagesScroll}
            contentContainerStyle={styles.messagesContent}
            keyboardShouldPersistTaps="handled"
          >
            {messages.length === 0 ? (
              <View style={styles.welcomeCard}>
                <Text style={styles.welcomeTitle}>Workforce Intelligence Ready</Text>
                <Text style={styles.welcomeText}>
                  Tap a quick chip above or ask anything about today&apos;s attendance, late arrivals, or department turnout.
                </Text>
              </View>
            ) : (
              messages.map((msg, idx) =>
                msg.role === "user" ? (
                  <View key={idx} style={styles.userBubble}>
                    <Text style={styles.userBubbleText}>{msg.content}</Text>
                  </View>
                ) : (
                  <View key={idx} style={styles.aiBubble}>
                    <Text style={styles.aiBubbleText}>{msg.content}</Text>
                    <View style={styles.aiBubbleFooter}>
                      <Text style={styles.aiTimeText}>GEMINI • {msg.timestamp}</Text>
                      <TouchableOpacity
                        style={styles.copyBtn}
                        onPress={() => handleCopy(msg.content, idx)}
                        activeOpacity={0.75}
                      >
                        <Ionicons
                          name={copiedIdx === idx ? "checkmark" : "copy-outline"}
                          size={12}
                          color="#142748"
                        />
                        <Text style={styles.copyBtnText}>
                          {copiedIdx === idx ? "COPIED" : "COPY"}
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                )
              )
            )}

            {isLoading && (
              <View style={styles.loadingBubble}>
                <ActivityIndicator size="small" color="#2d81ff" />
                <Text style={styles.loadingText}>Analyzing live attendance...</Text>
              </View>
            )}
          </ScrollView>

          {/* Input Bar */}
          <View style={styles.inputBar}>
            <TextInput
              style={styles.textInput}
              placeholder="Ask about punches, late arrivals..."
              placeholderTextColor="#94a3b8"
              value={input}
              onChangeText={setInput}
              editable={!isLoading}
              returnKeyType="send"
              onSubmitEditing={() => handleSend()}
            />
            <TouchableOpacity
              style={[styles.sendBtn, (!input.trim() || isLoading) && styles.sendBtnDisabled]}
              onPress={() => handleSend()}
              disabled={!input.trim() || isLoading}
              activeOpacity={0.85}
            >
              <Ionicons name="send" size={16} color="#ffffff" />
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(20, 39, 72, 0.55)",
    justifyContent: "flex-end",
  },
  sheet: {
    height: "82%",
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    overflow: "hidden",
    borderTopWidth: 2,
    borderTopColor: "#2d81ff",
  },
  header: {
    backgroundColor: "#142748",
    paddingHorizontal: 16,
    paddingVertical: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  aiIconBox: {
    width: 32,
    height: 32,
    backgroundColor: "#2d81ff",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: "#f2f1ee",
    fontSize: 15,
    fontWeight: "800",
  },
  headerSub: {
    color: "#93c5fd",
    fontSize: 10,
    fontWeight: "700",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
    marginTop: 2,
  },
  closeBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(242, 241, 238, 0.25)",
  },
  chipsScroll: {
    maxHeight: 50,
    backgroundColor: "#f2f1ee",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  chipsContent: {
    paddingHorizontal: 12,
    paddingVertical: 9,
    gap: 8,
    alignItems: "center",
  },
  chipPrimary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    backgroundColor: "#142748",
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  chipPrimaryText: {
    color: "#f2f1ee",
    fontSize: 11,
    fontWeight: "700",
  },
  chip: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d1d5db",
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  chipText: {
    color: "#142748",
    fontSize: 11,
    fontWeight: "600",
  },
  messagesScroll: {
    flex: 1,
    backgroundColor: "#fafafa",
  },
  messagesContent: {
    padding: 14,
    gap: 12,
  },
  welcomeCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 16,
  },
  welcomeTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#142748",
    marginBottom: 6,
  },
  welcomeText: {
    fontSize: 13,
    color: "#475569",
    lineHeight: 19,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "84%",
    backgroundColor: "#142748",
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  userBubbleText: {
    color: "#f2f1ee",
    fontSize: 13,
    lineHeight: 19,
  },
  aiBubble: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    padding: 12,
  },
  aiBubbleText: {
    color: "#142748",
    fontSize: 13,
    lineHeight: 20,
  },
  aiBubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },
  aiTimeText: {
    fontSize: 10,
    color: "#64748b",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: "#f2f1ee",
    borderWidth: 1,
    borderColor: "#d1d5db",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  copyBtnText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#142748",
    fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
  },
  loadingBubble: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  loadingText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#2d81ff",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    paddingBottom: Platform.OS === "ios" ? 24 : 12,
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#d1d5db",
    backgroundColor: "#f9fafb",
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: "#142748",
  },
  sendBtn: {
    width: 42,
    height: 42,
    backgroundColor: "#2d81ff",
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    backgroundColor: "#cbd5e1",
  },
});
