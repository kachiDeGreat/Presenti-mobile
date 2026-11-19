const FAST_LITE_MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
];

const FALLBACK_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-flash-lite-latest",
  "gemini-3.8-flash",
  "gemini-3.7-flash",
];

function getApiKey(): string {
  return (process.env.EXPO_PUBLIC_GEMINI_API_KEY || "").trim();
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
    throw err;
  }
}

async function callVisionJSON<T>(parts: Array<Record<string, unknown>>): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[FaceAI] EXPO_PUBLIC_GEMINI_API_KEY is empty");
    return null;
  }

  // Wave 1: Race the two fastest flash-lite models in parallel (5s cap)
  try {
    return await Promise.any(
      FAST_LITE_MODELS.map((model) => requestVisionModel<T>(model, apiKey, parts, 5000))
    );
  } catch {
    // Fall through to Wave 2
  }

  // Wave 2: Sequential fallback across remaining models (5s cap each)
  for (const model of FALLBACK_MODELS) {
    try {
      return await requestVisionModel<T>(model, apiKey, parts, 5500);
    } catch {
      // Try next model
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

  const result = await callVisionJSON<FaceEnrollmentResult>([
    { text: prompt },
    { inlineData: { mimeType: "image/jpeg", data: cleanB64 } },
  ]);

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

  const prompt = `You are a strict 1-to-1 biometric identity verification system for workforce attendance.
Image 1 is the ENROLLED ACCOUNT OWNER's reference face photo captured during onboarding.
Image 2 is the LIVE CAMERA CAPTURE of the person currently attempting to clock in or out.

CRITICAL SECURITY RULES:
1. First check if Image 2 actually contains a clearly visible human face. If there is NO face in Image 2 or it is too dark/blank/covered, you MUST set "verified": false, "isLivePerson": false, "confidence": 0, and "reason": "No face detected. Position your face clearly inside the circle."
2. Do NOT verify two different people just because they share the same gender, age range, or ethnicity.
3. Carefully compare unique individual identity markers between Image 1 and Image 2:
   - Cranial & facial bone structure, face shape, forehead-to-chin ratio, cheekbone width, and jawline contour
   - Eye shape, inter-pupillary distance, and eyebrow shape/arch
   - Nose bridge width, tip shape, nostril contour, and nose-to-lip proportion
   - Mouth/lip structure, ears, facial hair pattern, and distinctive facial features
4. If Image 1 and Image 2 are TWO DIFFERENT INDIVIDUALS (e.g., a friend, colleague, or another person trying to sign in on this account), you MUST set "verified": false, "confidence" below 40, and "reason": "Face mismatch: Live face does not match the enrolled account owner."
5. Check Image 2 for spoofing (holding up a phone screen, printed photo, or mask). If spoofed, set "isLivePerson": false and "verified": false.

Return ONLY valid JSON:
{
  "verified": boolean,
  "confidence": number,
  "isLivePerson": boolean,
  "reason": string
}`;

  const result = await callVisionJSON<FaceMatchResult>([
    { text: prompt },
    { inlineData: { mimeType: "image/jpeg", data: cleanRef } },
    { inlineData: { mimeType: "image/jpeg", data: cleanLive } },
  ]);

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
