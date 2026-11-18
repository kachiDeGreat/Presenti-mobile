import AsyncStorage from "@react-native-async-storage/async-storage";
import { doc, onSnapshot, setDoc } from "firebase/firestore";
import { db } from "../config/firebase";
import type { MobileChatMessage } from "./geminiService";

const MAX_HISTORY_MESSAGES = 30;

function getStorageKey(orgId: string, userId: string): string {
  return `@presenti_ai_chat_${orgId}_${userId}`;
}

export function subscribeToAIChatHistory(
  orgId: string | undefined,
  userId: string | undefined,
  onUpdate: (messages: MobileChatMessage[]) => void
): () => void {
  if (!orgId || !db) return () => {};
  const uid = userId || "default";
  const storageKey = getStorageKey(orgId, uid);

  // Instant local cache seed
  AsyncStorage.getItem(storageKey)
    .then((raw) => {
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            onUpdate(parsed);
          }
        } catch {}
      }
    })
    .catch(() => {});

  const chatRef = doc(db, "churches", orgId, "ai_chats", uid);
  return onSnapshot(
    chatRef,
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        const msgs = Array.isArray(data?.messages) ? (data.messages as MobileChatMessage[]) : [];
        AsyncStorage.setItem(storageKey, JSON.stringify(msgs)).catch(() => {});
        onUpdate(msgs);
      }
    },
    (err) => {
      console.warn("Mobile AI chat history sync notice:", err);
    }
  );
}

export async function saveAIChatHistory(
  orgId: string | undefined,
  userId: string | undefined,
  messages: MobileChatMessage[]
): Promise<void> {
  if (!orgId) return;
  const uid = userId || "default";
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);

  await AsyncStorage.setItem(getStorageKey(orgId, uid), JSON.stringify(trimmed)).catch(() => {});

  if (!db) return;
  try {
    const chatRef = doc(db, "churches", orgId, "ai_chats", uid);
    await setDoc(
      chatRef,
      {
        messages: trimmed,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("Failed to sync mobile AI chat history to cloud:", err);
  }
}

export async function clearAIChatHistory(
  orgId: string | undefined,
  userId: string | undefined
): Promise<void> {
  if (!orgId) return;
  const uid = userId || "default";

  await AsyncStorage.removeItem(getStorageKey(orgId, uid)).catch(() => {});

  if (!db) return;
  try {
    const chatRef = doc(db, "churches", orgId, "ai_chats", uid);
    await setDoc(
      chatRef,
      {
        messages: [],
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );
  } catch (err) {
    console.warn("Failed to clear cloud AI chat history:", err);
  }
}
