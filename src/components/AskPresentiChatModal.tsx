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
import { C, MONO, R, S, T, shadow, ui } from "../constants/premium";
import {
  askPresentiMobileAI,
  generateMobileBriefing,
  type MobileChatMessage,
  type MobileAIContext,
} from "../services/geminiService";
import {
  subscribeToAIChatHistory,
  saveAIChatHistory,
  clearAIChatHistory,
} from "../services/aiChatHistoryService";

interface AskPresentiChatModalProps {
  visible: boolean;
  onClose: () => void;
  context: MobileAIContext;
  organizationId?: string;
  userId?: string;
}

const QUICK_CHIPS = [
  "Who is late today?",
  "Department turnout",
  "Who hasn't checked in?",
];

function renderInlineMarkdown(line: string) {
  const normalized = line.replace(/^(\s*)[*-]\s+/, "$1• ");
  const parts = normalized.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <Text key={i} style={{ fontWeight: "800", color: "#142748" }}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <Text key={i} style={{ fontWeight: "800", color: "#142748" }}>
          {part.slice(1, -1)}
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
  organizationId,
  userId,
}) => {
  const toast = useToast();
  const [messages, setMessages] = useState<MobileChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  // Real-time cross-device chat history sync
  useEffect(() => {
    if (!organizationId) return;
    const unsubscribe = subscribeToAIChatHistory(organizationId, userId, (synced) => {
      setMessages(synced);
    });
    return () => unsubscribe();
  }, [organizationId, userId]);

  useEffect(() => {
    if (visible) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [messages, isLoading, visible]);

  const handleClearChat = () => {
    if (messages.length === 0 || isLoading) return;
    setMessages([]);
    toast.success("Chat history cleared across devices.");
    clearAIChatHistory(organizationId, userId).catch(() => {});
  };

  const handleBriefing = async () => {
    if (isLoading) return;
    const nowLabel = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const withUser: MobileChatMessage[] = [
      ...messages,
      { role: "user", content: "Generate today's Executive Briefing.", timestamp: nowLabel },
    ];
    setMessages(withUser);
    saveAIChatHistory(organizationId, userId, withUser);
    setIsLoading(true);

    try {
      const reply = await generateMobileBriefing(context);
      const withReply: MobileChatMessage[] = [
        ...withUser,
        {
          role: "assistant",
          content: reply,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ];
      setMessages(withReply);
      saveAIChatHistory(organizationId, userId, withReply);
    } catch (err: any) {
      const msg = err?.message || "Unable to reach Presenti AI.";
      toast.error(msg);
      const withErr: MobileChatMessage[] = [
        ...withUser,
        {
          role: "assistant",
          content: `Error: ${msg}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ];
      setMessages(withErr);
      saveAIChatHistory(organizationId, userId, withErr);
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
    const withUser = [...prevMsgs, userMsg];
    setMessages(withUser);
    saveAIChatHistory(organizationId, userId, withUser);
    setIsLoading(true);

    try {
      const reply = await askPresentiMobileAI(q, context, prevMsgs);
      const withReply: MobileChatMessage[] = [
        ...withUser,
        {
          role: "assistant",
          content: reply,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ];
      setMessages(withReply);
      saveAIChatHistory(organizationId, userId, withReply);
    } catch (err: any) {
      const msg = err?.message || "Unable to reach Presenti AI.";
      toast.error(msg);
      const withErr: MobileChatMessage[] = [
        ...withUser,
        {
          role: "assistant",
          content: `Error: ${msg}`,
          timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        },
      ];
      setMessages(withErr);
      saveAIChatHistory(organizationId, userId, withErr);
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
            <View style={ui.grabber} />
            <View style={styles.headerRow}>
              <View style={styles.headerLeft}>
                <View style={styles.aiIconBox}>
                  <Ionicons name="sparkles" size={18} color={C.accent} />
                </View>
                <View>
                  <Text style={styles.headerTitle}>Ask Presenti AI</Text>
                  <Text style={styles.headerSub}>PRESENTI INTELLIGENCE</Text>
                </View>
              </View>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {messages.length > 0 && (
                  <TouchableOpacity
                    onPress={handleClearChat}
                    disabled={isLoading}
                    style={styles.closeBtn}
                    activeOpacity={0.7}
                  >
                    <Ionicons name="trash-outline" size={17} color={C.ink} />
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={onClose} style={styles.closeBtn} activeOpacity={0.7}>
                  <Ionicons name="close" size={19} color={C.ink} />
                </TouchableOpacity>
              </View>
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
            {messages.filter((m) => m.content && m.content.trim().length > 0).length === 0 ? (
              <View style={styles.welcomeCard}>
                <Text style={styles.welcomeTitle}>Workforce Intelligence Ready</Text>
                <Text style={styles.welcomeText}>
                  Tap a quick chip above or ask anything about today&apos;s attendance, late arrivals, or department turnout.
                </Text>
              </View>
            ) : (
              messages
                .filter((m) => m.content && m.content.trim().length > 0)
                .map((msg, idx) =>
                msg.role === "user" ? (
                  <View key={idx} style={styles.userBubble}>
                    <Text style={styles.userBubbleText}>{msg.content}</Text>
                  </View>
                ) : (
                  <View key={idx} style={styles.aiBubble}>
                    {renderFormattedAIText(msg.content)}
                    <View style={styles.aiBubbleFooter}>
                      <Text style={styles.aiTimeText}>PRESENTI AI • {msg.timestamp}</Text>
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
    backgroundColor: C.overlay,
    justifyContent: "flex-end",
  },
  sheet: {
    height: "86%",
    ...ui.sheet,
    overflow: "hidden",
  },
  header: {
    backgroundColor: C.card,
    paddingHorizontal: S.lg,
    paddingTop: 4,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: C.lineCard,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  aiIconBox: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.accentSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    ...T.title,
    fontSize: 17,
  },
  headerSub: {
    ...T.labelSm,
    color: C.accent,
    marginTop: 2,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: C.cardAlt,
  },
  chipsWrapper: {
    backgroundColor: C.canvas,
    borderBottomWidth: 1,
    borderBottomColor: C.line,
  },
  chipsContent: {
    paddingHorizontal: S.md,
    paddingVertical: 10,
    gap: 8,
    flexDirection: "row",
    alignItems: "center",
  },
  chipPrimary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: C.ink,
    borderRadius: R.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipPrimaryText: {
    color: C.white,
    fontSize: 12,
    fontWeight: "700",
  },
  chip: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.lineCard,
    borderRadius: R.pill,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  chipText: {
    color: C.ink,
    fontSize: 12,
    fontWeight: "600",
  },
  messagesScroll: {
    flex: 1,
    backgroundColor: C.canvas,
  },
  messagesContent: {
    padding: S.md,
    gap: 14,
  },
  welcomeCard: {
    ...ui.card,
    padding: S.lg,
  },
  welcomeTitle: {
    ...T.heading,
    marginBottom: 6,
  },
  welcomeText: {
    ...T.caption,
    color: C.ink2,
    lineHeight: 20,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "82%",
    backgroundColor: C.ink,
    borderRadius: 18,
    borderBottomRightRadius: 4,
    paddingHorizontal: 15,
    paddingVertical: 11,
    ...shadow.card,
  },
  userBubbleText: {
    color: C.white,
    fontSize: 14,
    lineHeight: 20,
  },
  aiBubble: {
    alignSelf: "flex-start",
    maxWidth: "92%",
    backgroundColor: C.card,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    padding: S.md,
    ...shadow.card,
  },
  aiBubbleText: {
    color: C.ink,
    fontSize: 14,
    lineHeight: 21,
  },
  aiBubbleFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: C.lineCard,
  },
  aiTimeText: {
    ...T.labelSm,
    color: C.muted,
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: C.cardAlt,
    borderRadius: R.pill,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  copyBtnText: {
    ...T.labelSm,
    color: C.ink,
  },
  loadingBubble: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: C.card,
    borderRadius: 18,
    borderBottomLeftRadius: 4,
    paddingHorizontal: 14,
    paddingVertical: 11,
    ...shadow.card,
  },
  loadingText: {
    fontSize: 13,
    fontWeight: "600",
    color: C.accent,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: S.md,
    paddingTop: 10,
    paddingBottom: Platform.OS === "ios" ? 26 : 14,
    backgroundColor: C.card,
    borderTopWidth: 1,
    borderTopColor: C.lineCard,
  },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: C.line,
    borderRadius: R.pill,
    backgroundColor: C.cardAlt,
    paddingHorizontal: 16,
    paddingVertical: 11,
    fontSize: 14,
    color: C.ink,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
  },
  sendBtnDisabled: {
    backgroundColor: C.faint,
  },
});
