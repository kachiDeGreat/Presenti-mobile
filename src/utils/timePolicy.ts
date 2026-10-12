import type { PolicySettings } from '../types';

export const TIME_REGEX = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i;

export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export interface WindowEvaluationResult {
  isAllowed: boolean;
  status: 'WINDOW_OPEN' | 'BEFORE_WINDOW' | 'PAST_WINDOW' | 'NOT_SCHEDULED_DAY' | 'UNRESTRICTED';
  badgeLabel: string;
  badgeType: 'active' | 'warning' | 'error' | 'neutral';
  summary: string;
  openTimeFormatted: string;
  closeTimeFormatted: string;
  minutesRemaining?: number;
  rejectionReason?: string;
}

export function parseTimeToMinutes(timeStr?: string): number | null {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const clean = timeStr.trim().toUpperCase();
  const match = clean.match(TIME_REGEX);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = match[3]?.toUpperCase();

  if (period === 'PM' && hours < 12) {
    hours += 12;
  } else if (period === 'AM' && hours === 12) {
    hours = 0;
  }

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
}

export function format12Hour(timeStr?: string): string {
  if (!timeStr || typeof timeStr !== 'string') return '';
  const mins = parseTimeToMinutes(timeStr);
  if (mins === null) return timeStr;

  const hours = Math.floor(mins / 60);
  const minutes = mins % 60;
  const period = hours >= 12 ? 'PM' : 'AM';
  const displayHours = hours % 12 === 0 ? 12 : hours % 12;
  return `${String(displayHours).padStart(2, '0')}:${String(minutes).padStart(2, '0')} ${period}`;
}

export function formatCurrentTime(date: Date = new Date()): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function evaluateAttendanceWindow(
  policy?: PolicySettings,
  now: Date = new Date()
): WindowEvaluationResult {
  const currentDay = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentTime12 = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // 1. If no policy configured at all, allow sign-in
  if (!policy || (!policy.arrivalCutoff && !policy.lateTolerance && !policy.serviceDays?.length)) {
    return {
      isAllowed: true,
      status: 'UNRESTRICTED',
      badgeLabel: 'Window Active',
      badgeType: 'active',
      summary: 'Attendance window is unrestricted today.',
      openTimeFormatted: 'Open All Day',
      closeTimeFormatted: 'No Cutoff',
    };
  }

  // 2. Check scheduled service days
  if (Array.isArray(policy.serviceDays) && policy.serviceDays.length > 0) {
    const numericDays = policy.serviceDays.map((d) => Number(d));
    if (!numericDays.includes(currentDay)) {
      const scheduledNames = numericDays
        .filter((d) => d >= 0 && d <= 6)
        .map((d) => DAY_NAMES[d])
        .join(', ');

      return {
        isAllowed: false,
        status: 'NOT_SCHEDULED_DAY',
        badgeLabel: 'No Session Scheduled',
        badgeType: 'neutral',
        summary: `Today (${DAY_NAMES[currentDay]}) is not an active attendance day.`,
        openTimeFormatted: '--',
        closeTimeFormatted: '--',
        rejectionReason: `No attendance session scheduled for today. Scheduled operating days: ${scheduledNames || 'None'}.`,
      };
    }
  }

  // 3. Check time windows
  const openTime = policy.arrivalCutoff || '00:00';
  const closeTime = policy.lateTolerance || policy.syncCutoff || '23:59';

  const openMinutes = parseTimeToMinutes(openTime) ?? 0;
  const closeMinutes = parseTimeToMinutes(closeTime) ?? 1439;

  const formattedOpen = format12Hour(openTime);
  const formattedClose = format12Hour(closeTime);

  // If before window open
  if (currentMinutes < openMinutes) {
    const diff = openMinutes - currentMinutes;
    return {
      isAllowed: false,
      status: 'BEFORE_WINDOW',
      badgeLabel: `Opens at ${formattedOpen}`,
      badgeType: 'warning',
      summary: `Sign-in opens at ${formattedOpen} (in ${diff} min${diff > 1 ? 's' : ''}).`,
      openTimeFormatted: formattedOpen,
      closeTimeFormatted: formattedClose,
      minutesRemaining: diff,
      rejectionReason: `Sign-in window is not yet open. It begins at ${formattedOpen}. Current time is ${currentTime12}.`,
    };
  }

  // If past window close (LATE) - Strict cutoff
  if (currentMinutes > closeMinutes) {
    return {
      isAllowed: false,
      status: 'PAST_WINDOW',
      badgeLabel: 'Window Closed (Late)',
      badgeType: 'error',
      summary: `Attendance window closed at ${formattedClose}.`,
      openTimeFormatted: formattedOpen,
      closeTimeFormatted: formattedClose,
      rejectionReason: `The sign-in window closed at ${formattedClose}. Attendance is currently closed.`,
    };
  }

  // Within active window (ON TIME)
  const remaining = closeMinutes - currentMinutes;
  return {
    isAllowed: true,
    status: 'WINDOW_OPEN',
    badgeLabel: `Window Open • ${remaining}m left`,
    badgeType: 'active',
    summary: `Active until ${formattedClose} (${remaining} min${remaining > 1 ? 's' : ''} left).`,
    openTimeFormatted: formattedOpen,
    closeTimeFormatted: formattedClose,
    minutesRemaining: remaining,
  };
}
