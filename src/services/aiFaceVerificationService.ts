const VISION_MODELS = [
  "gemini-flash-lite-latest",
  "gemini-3.8-flash",
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

async function callVisionJSON<T>(parts: Array<Record<string, unknown>>): Promise<T | null> {
  const apiKey = getApiKey();
  if (!apiKey) return null;

  for (const model of VISION_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(
      apiKey
    )}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 9000);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 160,
            responseMimeType: "application/json",
          },
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) continue;

      const data = await res.json().catch(() => ({}));
      const rawText =
        data?.candidates?.[0]?.content?.parts
          ?.filter((p: { thought?: boolean; text?: string }) => !p.thought && Boolean(p.text))
          .map((p: { text?: string }) => p.text || "")
          .join("")
          .trim() || "";

      if (!rawText) continue;

      const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/i, "")
        .trim();

      return JSON.parse(cleaned) as T;
    } catch {
      clearTimeout(timeoutId);
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
Return ONLY valid JSON:
{
  "valid": boolean, // true ONLY if a single, clear, well-lit live human face is visible looking toward the camera (not a photo of a screen/paper, not covered)
  "reason": string, // short 3-6 word summary
  "guidance": string // short actionable tip if invalid, or "Face quality verified." if valid
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

  const prompt = `You are a strict biometric security verifier.
Image 1 is the enrolled employee's reference photo.
Image 2 is the live camera capture at clock-in.
Compare facial structure (eyes, nose, jawline, proportions) and check Image 2 for spoofing (holding up a phone screen, printed photo, or mask).
Return ONLY valid JSON:
{
  "verified": boolean, // true ONLY if Image 2 is clearly the SAME person as Image 1 AND is a live human
  "confidence": number, // integer 0 to 100
  "isLivePerson": boolean, // false if Image 2 looks like a photo of a screen/paper or no face
  "reason": string // short clear feedback for the user (e.g. "Identity confirmed" or "Face does not match enrolled profile" or "Step into brighter light")
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
    verified: Boolean(result.verified && result.isLivePerson && (result.confidence ?? 0) >= 65),
    confidence: Number(result.confidence ?? 0),
    isLivePerson: Boolean(result.isLivePerson),
    reason:
      result.reason ||
      (result.verified ? "Biometric identity confirmed." : "Face did not match enrolled profile."),
  };
}
