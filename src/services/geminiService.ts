export interface MobileChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface MobileAttendanceSummary {
  memberName: string;
  department: string;
  status: string;
  punchedAt: string;
  verificationMethod: string;
  signedOutAt?: string;
}

export interface MobileWorkforceSummary {
  fullName: string;
  department: string;
  isFaceEnrolled?: boolean;
  status?: string;
}

export interface MobileAIContext {
  organizationName: string;
  branchName?: string;
  dateLabel: string;
  totalCheckedIn: number;
  onTimeCount: number;
  lateCount: number;
  totalWorkforceCount: number;
  departments: string[];
  records: MobileAttendanceSummary[];
  members: MobileWorkforceSummary[];
}

const GEMINI_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.8-flash",
  "gemini-pro-latest",
  "gemma-4-31b-it",
];

function getGeminiKey(): string {
  return (process.env.EXPO_PUBLIC_GEMINI_API_KEY || "").trim();
}

function buildMobileSnapshot(ctx: MobileAIContext): string {
  const deptCounts: Record<string, { total: number; onTime: number; late: number }> = {};
  for (const r of ctx.records) {
    const d = r.department || "General";
    if (!deptCounts[d]) deptCounts[d] = { total: 0, onTime: 0, late: 0 };
    deptCounts[d].total += 1;
    if (r.status === "LATE") deptCounts[d].late += 1;
    else deptCounts[d].onTime += 1;
  }

  const punctualityPct =
    ctx.totalCheckedIn > 0
      ? Math.round((ctx.onTimeCount / ctx.totalCheckedIn) * 100)
      : 100;

  const checkedInNames = new Set(
    ctx.records.map((r) => (r.memberName || "").trim().toLowerCase())
  );
  const notCheckedInMembers = ctx.members
    .filter((m) => !checkedInNames.has((m.fullName || "").trim().toLowerCase()))
    .slice(0, 30)
    .map((m) => `${m.fullName} (${m.department || "General"})`);

  return JSON.stringify({
    organization: ctx.organizationName,
    branch: ctx.branchName || "Main Campus",
    date: ctx.dateLabel,
    hasAnyPunchesToday: ctx.totalCheckedIn > 0,
    metrics: {
      totalCheckedIn: ctx.totalCheckedIn,
      onTime: ctx.onTimeCount,
      late: ctx.lateCount,
      punctualityRatePercent: punctualityPct,
      totalRegisteredWorkforce: ctx.totalWorkforceCount,
    },
    departments: ctx.departments,
    departmentBreakdown: deptCounts,
    notCheckedInYet: notCheckedInMembers,
    recentPunches: ctx.records.slice(0, 35).map((r) => ({
      name: r.memberName,
      dept: r.department,
      status: r.status || "ON_TIME",
      time: r.punchedAt
        ? new Date(r.punchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : "N/A",
      method: r.verificationMethod,
      signedOut: Boolean(r.signedOutAt),
    })),
  });
}

function buildLocalFallbackReply(question: string, ctx: MobileAIContext): string {
  const q = question.toLowerCase();
  const org = ctx.organizationName || "your organization";

  if (/^(who|what)\s+are\s+you\b/.test(q.trim())) {
    return `I'm Presenti AI, your workforce intelligence assistant for ${org}.`;
  }

  if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(q.trim())) {
    return `Hello! How can I help you today?`;
  }

  if (q.includes("brief") || q.includes("summary") || q.includes("report")) {
    if (ctx.totalCheckedIn === 0) {
      return `Daily Briefing — ${org} (${ctx.dateLabel})\n• 0 check-ins recorded today out of ${ctx.totalWorkforceCount} registered staff.\n• Attendance stream is live and waiting for the first clock-in.`;
    }
    const rate = Math.round((ctx.onTimeCount / ctx.totalCheckedIn) * 100);
    return `Daily Briefing — ${org} (${ctx.dateLabel})\n• Checked In: ${ctx.totalCheckedIn} (${rate}% on time)\n• On Time: ${ctx.onTimeCount} | Late: ${ctx.lateCount}\n• Registered Workforce: ${ctx.totalWorkforceCount}`;
  }

  if (q.includes("late")) {
    if (ctx.totalCheckedIn === 0) {
      return `0 employees have checked in today for ${org} (${ctx.totalWorkforceCount} registered staff), so there is no attendance data yet.`;
    }
    const lateList = ctx.records.filter((r) => r.status === "LATE");
    if (lateList.length === 0) {
      return `All ${ctx.totalCheckedIn} checked-in employees arrived on time today!`;
    }
    return `Late arrivals today (${lateList.length}):\n` +
      lateList.slice(0, 15).map((r) => `• ${r.memberName} (${r.department || "General"})`).join("\n");
  }

  if (q.includes("department") || q.includes("turnout")) {
    if (ctx.totalCheckedIn === 0) {
      return `0 employees have checked in today for ${org}, so department turnout is currently 0 across ${ctx.departments.length || 0} configured departments.`;
    }
    const counts: Record<string, number> = {};
    for (const r of ctx.records) {
      const d = r.department || "General";
      counts[d] = (counts[d] || 0) + 1;
    }
    return `Department turnout today:\n` +
      Object.entries(counts).map(([d, c]) => `• ${d}: ${c} checked in`).join("\n");
  }

  if (q.includes("hasn't") || q.includes("not checked") || q.includes("absent") || q.includes("missing")) {
    const checked = new Set(ctx.records.map((r) => (r.memberName || "").trim().toLowerCase()));
    const missing = ctx.members.filter((m) => !checked.has((m.fullName || "").trim().toLowerCase()));
    if (missing.length === 0 && ctx.members.length > 0) {
      return `All ${ctx.members.length} registered staff have checked in today!`;
    }
    if (ctx.members.length === 0) {
      return `No registered workforce profiles are loaded yet for ${org}. Pull down to refresh or enroll staff on the mobile app.`;
    }
    return `${missing.length} registered staff haven't checked in yet:\n` +
      missing.slice(0, 15).map((m) => `• ${m.fullName} (${m.department || "General"})`).join("\n");
  }

  return `${org} currently has ${ctx.totalCheckedIn} check-ins today (${ctx.onTimeCount} on time, ${ctx.lateCount} late) out of ${ctx.totalWorkforceCount} registered staff. (Cloud AI is temporarily busy — try asking again in a moment for deeper analysis.)`;
}

async function callGeminiMobile(
  systemInstruction: string,
  prompt: string,
  fallbackText: string
): Promise<string> {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    return fallbackText;
  }

  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;
    const isGemma = model.startsWith("gemma-");
    const payload = isGemma
      ? {
          contents: [
            {
              role: "user",
              parts: [{ text: `${systemInstruction}\n\n${prompt}` }],
            },
          ],
          generationConfig: { temperature: 0.3, maxOutputTokens: 450 },
        }
      : {
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 450 },
        };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        continue;
      }

      const text =
        data?.candidates?.[0]?.content?.parts
          ?.filter((p: { thought?: boolean; text?: string }) => !p.thought && Boolean(p.text))
          .map((p: { text?: string }) => p.text || "")
          .join("")
          .trim() || "";

      if (text) {
        return text;
      }
    } catch {
      clearTimeout(timeoutId);
    }
  }

  return fallbackText;
}

export async function askPresentiMobileAI(
  question: string,
  context: MobileAIContext,
  history: MobileChatMessage[] = []
): Promise<string> {
  const systemInstruction = `You are Presenti AI, an intelligent, friendly, all-round assistant for "${context.organizationName}".
- Do NOT introduce yourself (do not say "I am Presenti AI for...") unless the user specifically asks who or what you are. Just answer their question or greeting directly.
- You can answer ANY question naturally: greetings, general advice, HR/leadership tips, how Presenti works (Wi-Fi BSSID anchors, GPS geofencing, biometrics, executive reports), or live attendance analytics.
- When asked about attendance, late arrivals, departments, or staff, use the live telemetry below accurately.
- If "hasAnyPunchesToday" is false (0 check-ins today), clearly state that 0 check-ins have been recorded today for ${context.organizationName} yet.
- Never invent employee names or punch counts. Keep answers concise and easy to read on mobile.`;

  const recentHistory = history
    .slice(-4)
    .map((m) => `${m.role === "user" ? "Admin" : "Presenti AI"}: ${m.content}`)
    .join("\n");

  const prompt = `LIVE TELEMETRY:
${buildMobileSnapshot(context)}

${recentHistory ? `RECENT CHAT:\n${recentHistory}\n\n` : ""}USER MESSAGE:
${question}`;

  return callGeminiMobile(systemInstruction, prompt, buildLocalFallbackReply(question, context));
}

export async function generateMobileBriefing(context: MobileAIContext): Promise<string> {
  const systemInstruction = `You are Presenti AI. Write a crisp, WhatsApp-ready executive attendance briefing for "${context.organizationName}" using ONLY the provided live numbers and names. If 0 check-ins are recorded today, state that clearly. Keep it concise with bullet points.`;

  const prompt = `Generate today's Executive Attendance Briefing:\n${buildMobileSnapshot(context)}`;
  return callGeminiMobile(
    systemInstruction,
    prompt,
    buildLocalFallbackReply("briefing", context)
  );
}
