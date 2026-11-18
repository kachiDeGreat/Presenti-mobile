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

async function callGeminiMobile(systemInstruction: string, prompt: string): Promise<string> {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error("Gemini API key is missing. Check EXPO_PUBLIC_GEMINI_API_KEY in .env.");
  }

  let lastError = "Unable to reach Presenti AI.";

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
          generationConfig: { temperature: 0.2, maxOutputTokens: 450 },
        }
      : {
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 450,
            thinkingConfig: { thinkingBudget: 0 },
          },
        };

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastError = data?.error?.message || `API error (${res.status})`;
        // Retry next model on rate limit, overload, high demand, or unavailable model
        continue;
      }

      const text =
        data?.candidates?.[0]?.content?.parts
          ?.map((p: { text?: string }) => p.text || "")
          .join("")
          .trim() || "";

      if (text) {
        return text;
      }
      lastError = "Model returned an empty response.";
    } catch (err: any) {
      lastError = err?.message || "Network error contacting Gemini.";
    }
  }

  throw new Error(lastError);
}

export async function askPresentiMobileAI(
  question: string,
  context: MobileAIContext,
  history: MobileChatMessage[] = []
): Promise<string> {
  const systemInstruction = `You are Presenti AI, a fast workforce intelligence assistant for "${context.organizationName}".
Answer concisely and accurately using ONLY the live telemetry provided.
- CRITICAL: If "hasAnyPunchesToday" is false (0 check-ins today), ALWAYS state clearly that 0 employees have checked in today for ${context.organizationName} (and mention totalRegisteredWorkforce / notCheckedInYet if relevant) instead of simply saying "no one is late".
- Never invent names or numbers not present in the telemetry.
- Keep answers short, direct, and formatted with clean bullet points.`;

  const recentHistory = history
    .slice(-6)
    .map((m) => `${m.role === "user" ? "Admin" : "Presenti AI"}: ${m.content}`)
    .join("\n");

  const prompt = `LIVE TELEMETRY:
${buildMobileSnapshot(context)}

${recentHistory ? `RECENT CHAT:\n${recentHistory}\n\n` : ""}QUESTION:
${question}`;

  return callGeminiMobile(systemInstruction, prompt);
}

export async function generateMobileBriefing(context: MobileAIContext): Promise<string> {
  const systemInstruction = `You are Presenti AI. Write a crisp, WhatsApp-ready executive attendance briefing for mobile leadership using ONLY the provided live numbers and names. Keep it concise with bullet points.`;

  const prompt = `Generate today's Executive Attendance Briefing:\n${buildMobileSnapshot(context)}`;
  return callGeminiMobile(systemInstruction, prompt);
}
