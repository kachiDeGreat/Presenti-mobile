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

function renderInlineMarkdown(line: string) {
  const normalized = line.replace(/^(\s*)[*-]\s+/, "$1• ");
  const parts = normalized.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <Text key={i} style={{ fontWeight: "800", color: "#142748" }}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <Text
          key={i}
          style={{
            fontFamily: Platform.OS === "ios" ? "ui-monospace" : "monospace",
            backgroundColor: "#f2f1ee",
            color: "#142748",
            fontSize: 12,
          }}
        >
          {part.slice(1, -1)}
        </Text>
      );
    }
    return <Text key={i}>{part}</Text>;
  });
}

/** Renders headings (###), dividers (---), **bold**, `code`, and bullets cleanly */
function renderFormattedAIText(raw: string) {
  const lines = raw.split(/\r?\n/);
  return (
    <View style={{ gap: 4 }}>
      {lines.map((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return <View key={idx} style={{ height: 4 }} />;
        }
        if (/^[-*_]{3,}$/.test(trimmed)) {
          return (
            <View
              key={idx}
              style={{ height: 1, backgroundColor: "#e5e7eb", marginVertical: 5 }}
            />
          );
        }
        const headingMatch = trimmed.match(/^#{1,4}\s+(.+)$/);
        if (headingMatch) {
          return (
            <Text
              key={idx}
              style={{
                fontSize: 14,
                fontWeight: "800",
                color: "#142748",
                marginTop: idx === 0 ? 0 : 4,
                marginBottom: 2,
              }}
            >
              {renderInlineMarkdown(headingMatch[1])}
            </Text>
          );
        }
        return (
          <Text key={idx} style={styles.aiBubbleText}>
            {renderInlineMarkdown(line)}
          </Text>
        );
      })}
    </View>
  );
}

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
            <View style={styles.dragPill} />
            <View style={styles.headerRow}>
              <View style={styles.headerLeft}>
                <View style={styles.aiIconBox}>
                  <Ionicons name="sparkles" size={17} color="#ffffff" />
                </View>
                <View>
                  <Text style={styles.headerTitle}>Ask Presenti AI</Text>
                  <Text style={styles.headerSub}>
                    GEMINI INTELLIGENCE • {context.totalCheckedIn} PUNCHES
                  </Text>
                </View>
              </View>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
                <Ionicons name="close" size={18} color="#f2f1ee" />
              </TouchableOpacity>
            </View>
          </View>

          {/* Quick Prompt Chips */}
          <View style={styles.chipsWrapper}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
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
          </View>

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
                    {renderFormattedAIText(msg.content)}
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
    height: "84%",
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    overflow: "hidden",
  },
  header: {
    backgroundColor: "#142748",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 14,
  },
  dragPill: {
    alignSelf: "center",
    width: 38,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255, 255, 255, 0.25)",
    marginBottom: 10,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
  },
  aiIconBox: {
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: "#2d81ff",
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    color: "#ffffff",
    fontSize: 16,
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
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255, 255, 255, 0.12)",
  },
  chipsWrapper: {
    backgroundColor: "#f2f1ee",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  chipsContent: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  chipPrimary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#142748",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipPrimaryText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "700",
  },
  chip: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d1d5db",
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: {
    color: "#142748",
    fontSize: 12,
    fontWeight: "600",
  },
  messagesScroll: {
    flex: 1,
    backgroundColor: "#f8fafc",
  },
  messagesContent: {
    padding: 16,
    gap: 14,
  },
  welcomeCard: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 16,
    padding: 18,
    shadowColor: "#142748",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.04,
    shadowRadius: 6,
    elevation: 2,
  },
  welcomeTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#142748",
    marginBottom: 6,
  },
  welcomeText: {
    fontSize: 13,
    color: "#475569",
    lineHeight: 20,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "82%",
    backgroundColor: "#142748",
    borderRadius: 18,
    borderBottomRightRadius: 4,
    paddingHorizontal: 15,
    paddingVertical: 11,
    shadowColor: "#142748",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 4,
    elevation: 2,
  },
  userBubbleText: {
    color: "#ffffff",
    fontSize: 13.5,
    lineHeight: 20,
  },
  aiBubble: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    padding: 14,
    shadowColor: "#142748",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  aiBubbleText: {
    color: "#142748",
    fontSize: 13.5,
    lineHeight: 21,
  },
  aiBubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
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
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
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
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  loadingText: {
    fontSize: 12.5,
    fontWeight: "600",
    color: "#2d81ff",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 26 : 14,
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#e5e7eb",
    borderRadius: 24,
    backgroundColor: "#f2f1ee",
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 13.5,
    color: "#142748",
  },
  sendBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "#2d81ff",
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    backgroundColor: "#cbd5e1",
  },
});
