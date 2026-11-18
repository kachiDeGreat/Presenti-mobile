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

const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent";

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

  return JSON.stringify(
    {
      organization: ctx.organizationName,
      branch: ctx.branchName || "Main Campus",
      date: ctx.dateLabel,
      metrics: {
        totalCheckedIn: ctx.totalCheckedIn,
        onTime: ctx.onTimeCount,
        late: ctx.lateCount,
        punctualityRatePercent: punctualityPct,
        totalRegisteredWorkforce: ctx.totalWorkforceCount,
      },
      departments: ctx.departments,
      departmentBreakdown: deptCounts,
      recentPunches: ctx.records.slice(0, 45).map((r) => ({
        name: r.memberName,
        dept: r.department,
        status: r.status || "ON_TIME",
        time: r.punchedAt
          ? new Date(r.punchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
          : "N/A",
        method: r.verificationMethod,
        signedOut: Boolean(r.signedOutAt),
      })),
      registeredMembersSample: ctx.members.slice(0, 45).map((m) => ({
        name: m.fullName,
        dept: m.department,
        status: m.status || "ACTIVE",
        faceEnrolled: Boolean(m.isFaceEnrolled),
      })),
    },
    null,
    2
  );
}

async function callGeminiMobile(systemInstruction: string, prompt: string): Promise<string> {
  const apiKey = getGeminiKey();
  if (!apiKey) {
    throw new Error("Gemini API key is missing. Check EXPO_PUBLIC_GEMINI_API_KEY in .env.");
  }

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }],
        },
      ],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 700,
      },
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const errMsg = data?.error?.message || `Gemini API error (${res.status})`;
    throw new Error(errMsg);
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((p: { text?: string }) => p.text || "")
      .join("")
      .trim() || "";

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }
  return text;
}

export async function askPresentiMobileAI(
  question: string,
  context: MobileAIContext,
  history: MobileChatMessage[] = []
): Promise<string> {
  const systemInstruction = `You are Presenti AI, a mobile workforce intelligence assistant for "${context.organizationName}".
Answer concisely and accurately using ONLY the live telemetry provided.
- Never invent names or numbers not present in the telemetry.
- Format cleanly for a mobile chat bubble using short bullet points.`;

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
