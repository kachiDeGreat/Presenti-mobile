const GROQ_VISION_MODELS = [
  "qwen/qwen3.8-27b",
  "meta-llama/llama-4-scout-17b-16e-instruct",
];

// Single-request sequential fallback: 1 API call per scan (preserves RPM quota for 30+ concurrent workers)
const VISION_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.7-flash",
  "gemini-3.8-flash",
];

function getApiKey(): string {
  return (process.env.EXPO_PUBLIC_GEMINI_API_KEY || "").trim();
}

function getGroqApiKey(): string {
  return (process.env.EXPO_PUBLIC_GROQ_API_KEY || "").trim();
}

export interface FaceEnrollmentResult {
  valid: boolean;
  reason: string;
  guidance: string;
}

export interface FaceMatchResult {
  verified: boolean;
  confidence: number;
  isLivePerson: boolean;
  reason: string;
}

function stripDataUriPrefix(b64: string): string {
  const idx = b64.indexOf("base64,");
  return idx !== -1 ? b64.slice(idx + 7) : b64;
}

async function urlToBase64(urlOrDataUri: string): Promise<string> {
  if (!urlOrDataUri) return "";
  if (urlOrDataUri.startsWith("data:") || !urlOrDataUri.startsWith("http")) {
    return stripDataUriPrefix(urlOrDataUri);
  }
  const res = await fetch(urlOrDataUri);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(stripDataUriPrefix(result));
    };
    reader.onerror = () => reject(new Error("Could not read reference profile image."));
    reader.readAsDataURL(blob);
  });
}

async function requestVisionModel<T>(
  model: string,
  apiKey: string,
  parts: Array<Record<string, unknown>>,
  timeoutMs: number
): Promise<T> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 512,
          responseMimeType: "application/json",
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.warn(`[FaceAI] Model ${model} HTTP ${res.status}:`, errBody.slice(0, 180));
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json().catch(() => ({}));
    const rawText =
      data?.candidates?.[0]?.content?.parts
        ?.filter((p: { thought?: boolean; text?: string }) => !p.thought && Boolean(p.text))
        .map((p: { text?: string }) => p.text || "")
        .join("")
        .trim() || "";

    if (!rawText) {
      throw new Error("Empty response");
    }

    const cleaned = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    const jsonSlice =
      firstBrace !== -1 && lastBrace > firstBrace
        ? cleaned.slice(firstBrace, lastBrace + 1)
        : cleaned;

    return JSON.parse(jsonSlice) as T;
  } catch (err: any) {
    clearTimeout(timeoutId);
    console.warn(`[FaceAI] Model ${model} failed:`, err?.message || err);
    throw err;
  }
}

async function callGroqVisionJSON<T>(
  prompt: string,
  imagesBase64: string[],
  timeoutMs: number = 8000
): Promise<T | null> {
  const groqKey = getGroqApiKey();
  if (!groqKey) return null;

  const content: Array<Record<string, unknown>> = [
    { type: "text", text: prompt },
    ...imagesBase64.map((b64) => ({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${b64}` },
    })),
  ];

  for (const groqModel of GROQ_VISION_MODELS) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${groqKey}`,
        },
        body: JSON.stringify({
          model: groqModel,
          messages: [{ role: "user", content }],
          temperature: 0.1,
          max_tokens: 300,
          response_format: { type: "json_object" },
          ...(groqModel.includes("qwen") ? { reasoning_effort: "none" } : {}),
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        const errBody = await res.text().catch(() => "");
        console.warn(`[FaceAI] Groq ${groqModel} HTTP ${res.status}:`, errBody.slice(0, 180));
        continue;
      }

      const data = await res.json().catch(() => ({}));
      const rawText = String(data?.choices?.[0]?.message?.content || "").trim();
      if (!rawText) continue;

      const cleaned = rawText
        .replace(/<think>[\s\S]*?<\/think>/gi, "")
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/i, "")
        .trim();

      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      const jsonSlice =
        firstBrace !== -1 && lastBrace > firstBrace
          ? cleaned.slice(firstBrace, lastBrace + 1)
          : cleaned;

      return JSON.parse(jsonSlice) as T;
    } catch (err: any) {
      clearTimeout(timeoutId);
      console.warn(`[FaceAI] Groq ${groqModel} failed:`, err?.message || err);
    }
  }

  return null;
}

async function callVisionJSON<T>(parts: Array<Record<string, unknown>>): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[FaceAI] EXPO_PUBLIC_GEMINI_API_KEY is empty");
    return null;
  }

  for (let i = 0; i < VISION_MODELS.length; i++) {
    const model = VISION_MODELS[i];
    try {
      return await requestVisionModel<T>(model, apiKey, parts, i === 0 ? 12000 : 9000);
    } catch {
      // Brief pause before falling back so we don't slam the rate limiter
      if (i < VISION_MODELS.length - 1) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  return null;
}

/**
 * Validates that a captured enrollment selfie clearly shows one live human face.
 */
export async function verifyFaceEnrollment(liveBase64: string): Promise<FaceEnrollmentResult> {
  const cleanB64 = stripDataUriPrefix(liveBase64);
  if (!cleanB64) {
    return {
      valid: false,
      reason: "No image captured.",
      guidance: "Center your face inside the circle and tap Scan.",
    };
  }

  const prompt = `Analyze this selfie for biometric attendance enrollment.
Be fair about normal indoor lighting: accept if a single live human face is clearly visible and eyes, nose, and mouth are distinguishable (not a photo of a screen/paper, not covered).
If invalid, give exact specific feedback:
- No face visible -> reason: "No face detected", guidance: "Point the camera directly at your face."
- Too dark / backlit / shadows hide features -> reason: "Poor lighting detected", guidance: "Move to a brighter spot or face a light source."
- Face cut off, too far, or off-center -> reason: "Face not well fitted", guidance: "Center your full face inside the circle."
- Photo of screen/paper -> reason: "Live face required", guidance: "Look directly at the camera — no photos or screens."
Return ONLY valid JSON:
{
  "valid": boolean,
  "reason": string,
  "guidance": string
}`;

  const result =
    (await callGroqVisionJSON<FaceEnrollmentResult>(prompt, [cleanB64])) ||
    (await callVisionJSON<FaceEnrollmentResult>([
      { text: prompt },
      { inlineData: { mimeType: "image/jpeg", data: cleanB64 } },
    ]));

  if (!result) {
    return {
      valid: false,
      reason: "Verification service busy.",
      guidance: "Please check your internet connection and tap Scan again.",
    };
  }

  return {
    valid: Boolean(result.valid),
    reason: result.reason || (result.valid ? "Face enrolled." : "Face not clear."),
    guidance:
      result.guidance ||
      (result.valid
        ? "Biometric profile captured."
        : "Move into brighter light and center your face in the circle."),
  };
}

/**
 * Compares a live clock-in selfie against the worker's enrolled reference photo,
 * including anti-spoofing (live human vs screen/printed photo).
 */
export async function verifyFaceMatch(
  liveBase64: string,
  referencePhotoUrlOrBase64: string
): Promise<FaceMatchResult> {
  const cleanLive = stripDataUriPrefix(liveBase64);
  if (!cleanLive) {
    return {
      verified: false,
      confidence: 0,
      isLivePerson: false,
      reason: "No camera frame captured. Please try again.",
    };
  }

  let cleanRef = "";
  try {
    cleanRef = await urlToBase64(referencePhotoUrlOrBase64);
  } catch {
    return {
      verified: false,
      confidence: 0,
      isLivePerson: true,
      reason: "Could not load your enrolled biometric photo. Check connection.",
    };
  }

  if (!cleanRef) {
    return {
      verified: false,
      confidence: 0,
      isLivePerson: true,
      reason: "No enrolled face profile found.",
    };
  }

  const prompt = `Strict 1-to-1 face verification.
Image 1: enrolled owner. Image 2: live camera.
Rules:
1. If Image 2 has no clear face or is too dark, set verified=false, isLivePerson=false, confidence=0, reason="No face detected. Position your face clearly inside the circle."
2. Compare unique facial structure (eyes, nose bridge, jawline, cheekbones, proportions). Never match two different people. If different individuals, set verified=false, confidence<40, reason="Face mismatch: Live face does not match the enrolled account owner."
3. If Image 2 is a screen/photo/mask, set isLivePerson=false, verified=false.
Return ONLY JSON: {"verified":boolean,"confidence":number,"isLivePerson":boolean,"reason":string}`;

  const result =
    (await callGroqVisionJSON<FaceMatchResult>(prompt, [cleanRef, cleanLive])) ||
    (await callVisionJSON<FaceMatchResult>([
      { text: prompt },
      { inlineData: { mimeType: "image/jpeg", data: cleanRef } },
      { inlineData: { mimeType: "image/jpeg", data: cleanLive } },
    ]));

  if (!result) {
    return {
      verified: false,
      confidence: 0,
      isLivePerson: true,
      reason: "Unable to verify right now. Check connection and try again.",
    };
  }

  return {
    verified: Boolean(result.verified && result.isLivePerson && (result.confidence ?? 0) >= 75),
    confidence: Number(result.confidence ?? 0),
    isLivePerson: Boolean(result.isLivePerson),
    reason:
      result.reason ||
      (result.verified
        ? "Biometric identity confirmed."
        : "Face mismatch: Live face does not match the enrolled account owner."),
  };
}
