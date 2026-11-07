import { doc, getDoc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../config/firebase';
import {
  renderMobileVerificationEmail,
  renderMobileWelcomeEmail,
} from '../utils/mobileEmailTemplate';

export interface MobileOtpRecord {
  code: string;
  email: string;
  purpose: 'SIGNUP' | 'RESET_PASSWORD';
  expiresAt: number;
  attempts: number;
  createdAt: number;
}

export interface SendMobileOtpResult {
  success: boolean;
  message: string;
  devCode?: string;
}

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

// Resolves backend API URL for sending emails via Gmail SMTP
export function getApiBaseUrl(): string {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/$/, '');
  }
  // Production Vercel or local fallback
  return 'https://presenti-admin-web.vercel.app';
}

/**
 * Generates a random 6-digit numeric string (100000 - 999999).
 */
export function generateRandom6DigitCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Dispatches an email via backend Gmail SMTP proxy.
 */
async function dispatchEmail(
  toEmail: string,
  code: string,
  purpose: 'SIGNUP' | 'RESET_PASSWORD' | 'WELCOME',
  subject: string,
  htmlContent: string
): Promise<{ sent: boolean; provider: string; error?: string }> {
  const baseUrl = getApiBaseUrl();

  try {
    const res = await fetch(`${baseUrl}/api/auth/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: toEmail,
        code,
        purpose,
        subject,
        html: htmlContent,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        return { sent: true, provider: data.provider || 'Gmail' };
      }
      return { sent: false, provider: 'DevConsole', error: data.error };
    }
  } catch (err: any) {
    console.warn('[Mobile Email Service] Backend dispatch network notice:', err?.message || err);
  }

  // Dev mode console fallback
  console.info(
    `[PRESENTI MOBILE OTP] Code for ${toEmail}: ${code} (${purpose})`
  );

  return { sent: false, provider: 'DevConsole' };
}

/**
 * Sends a 6-digit verification code for new mobile account registration.
 */
export async function sendMobileSignupOtp(email: string): Promise<SendMobileOtpResult> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter a valid work email address.');
  }

  const code = generateRandom6DigitCode();
  const expiresAt = Date.now() + OTP_TTL_MS;

  // Persist code in Firestore for tamper-proof verification
  if (db) {
    const otpDocRef = doc(db, '_email_otps', cleanEmail);
    await setDoc(otpDocRef, {
      code,
      email: cleanEmail,
      purpose: 'SIGNUP',
      expiresAt,
      attempts: 0,
      createdAt: Date.now(),
    } satisfies MobileOtpRecord);
  }

  const subject = `Welcome to Presenti — Your Verification Code: ${code}`;
  const htmlContent = renderMobileVerificationEmail(code, 'SIGNUP', cleanEmail);

  const dispatch = await dispatchEmail(cleanEmail, code, 'SIGNUP', subject, htmlContent);

  let message = `Verification code dispatched via ${dispatch.provider}. Please check your inbox.`;
  if (!dispatch.sent) {
    message = `Verification code generated. (Dev Demo Code: ${code})`;
  }

  return {
    success: true,
    message,
    devCode: dispatch.sent ? undefined : code,
  };
}

/**
 * Sends a 6-digit code to authorize a password reset on mobile.
 */
export async function sendMobilePasswordResetOtp(email: string): Promise<SendMobileOtpResult> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) {
    throw new Error('Please enter your registered email address.');
  }

  const code = generateRandom6DigitCode();
  const expiresAt = Date.now() + OTP_TTL_MS;

  if (db) {
    const otpDocRef = doc(db, '_email_otps', cleanEmail);
    await setDoc(otpDocRef, {
      code,
      email: cleanEmail,
      purpose: 'RESET_PASSWORD',
      expiresAt,
      attempts: 0,
      createdAt: Date.now(),
    } satisfies MobileOtpRecord);
  }

  const subject = `Presenti Security — Password Reset Code: ${code}`;
  const htmlContent = renderMobileVerificationEmail(code, 'RESET_PASSWORD', cleanEmail);

  const dispatch = await dispatchEmail(cleanEmail, code, 'RESET_PASSWORD', subject, htmlContent);

  let message = `Password reset code sent via ${dispatch.provider}. Check your inbox.`;
  if (!dispatch.sent) {
    message = `Password reset code generated. (Dev Demo Code: ${code})`;
  }

  return {
    success: true,
    message,
    devCode: dispatch.sent ? undefined : code,
  };
}

/**
 * Verifies a 6-digit OTP code against Firestore.
 */
export async function verifyMobileOtp(
  email: string,
  enteredCode: string,
  purpose: 'SIGNUP' | 'RESET_PASSWORD'
): Promise<boolean> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanCode = enteredCode.trim();

  if (!cleanCode || cleanCode.length !== 6) {
    throw new Error('Please enter the full 6-digit code.');
  }

  if (!db) {
    return true; // demo fallback
  }

  const otpDocRef = doc(db, '_email_otps', cleanEmail);
  const snap = await getDoc(otpDocRef);

  if (!snap.exists()) {
    throw new Error('No active verification code found. Please request a new code.');
  }

  const record = snap.data() as MobileOtpRecord;

  if (record.purpose !== purpose) {
    throw new Error('Invalid code purpose. Please request a new code.');
  }

  if (Date.now() > record.expiresAt) {
    await deleteDoc(otpDocRef).catch(() => {});
    throw new Error('Verification code has expired. Please request a fresh code.');
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    await deleteDoc(otpDocRef).catch(() => {});
    throw new Error('Too many incorrect attempts. Please request a new code.');
  }

  if (record.code !== cleanCode) {
    const remaining = MAX_ATTEMPTS - (record.attempts + 1);
    await setDoc(otpDocRef, { ...record, attempts: record.attempts + 1 });
    throw new Error(
      remaining > 0
        ? `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
        : 'Too many incorrect attempts. Please request a new code.'
    );
  }

  // Code verified! Delete document
  await deleteDoc(otpDocRef).catch(() => {});
  return true;
}

/**
 * Dispatches a branded Presenti Welcome Email upon successful registration on mobile.
 */
export async function sendMobileWelcomeEmail(
  email: string,
  name: string,
  role: 'ADMIN' | 'WORKER'
): Promise<void> {
  const cleanEmail = email.trim().toLowerCase();
  if (!cleanEmail || !cleanEmail.includes('@')) return;

  const subject =
    role === 'ADMIN'
      ? `Welcome to Presenti — Your Administrator Account is Ready`
      : `Welcome to Presenti — Your Workforce Account is Active`;

  const htmlContent = renderMobileWelcomeEmail(name, role, cleanEmail);

  try {
    await dispatchEmail(cleanEmail, 'WELCOME', 'WELCOME', subject, htmlContent);
  } catch (err) {
    console.warn('[Welcome Email Mobile] Dispatch notice:', err);
  }
}

