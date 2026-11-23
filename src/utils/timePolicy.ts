import type { PolicySettings, TodayPunchRecord } from '../types';

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
  status:
    | 'WINDOW_OPEN'
    | 'WINDOW_OPEN_LATE'
    | 'BEFORE_WINDOW'
    | 'PAST_WINDOW'
    | 'NOT_SCHEDULED_DAY'
    | 'UNRESTRICTED';
  attendanceStatus: 'ON_TIME' | 'LATE';
  badgeLabel: string;
  badgeType: 'active' | 'warning' | 'error' | 'neutral';
  summary: string;
  openTimeFormatted: string;
  closeTimeFormatted: string;
  enableSignOut: boolean;
  signOutTimeFormatted?: string;
  canSignOut: boolean;
  minutesRemaining?: number;
  rejectionReason?: string;
  activeShiftName?: string;
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
  now: Date = new Date(),
  todayPunch?: TodayPunchRecord | null,
  assignedShiftId?: string
): WindowEvaluationResult {
  const currentDay = now.getDay();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const currentTime12 = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Multi-Shift resolution (Morning / Afternoon / Night, including overnight shifts)
  const isMultiShift = policy?.scheduleMode === 'MULTI_SHIFT' && Array.isArray(policy.shifts) && policy.shifts.length > 0;
  const rawShift = isMultiShift
    ? (policy!.shifts!.find((s) => s.id === assignedShiftId && s.enabled !== false) ||
       policy!.shifts!.find((s) => s.enabled !== false) ||
       policy!.shifts![0])
    : undefined;
  const shiftDayOverride = rawShift?.dayOverrides?.[currentDay];
  const activeShift = rawShift
    ? {
        ...rawShift,
        arrivalCutoff: shiftDayOverride?.arrivalCutoff || rawShift.arrivalCutoff,
        lateTolerance: shiftDayOverride?.lateTolerance || rawShift.lateTolerance,
        signOutTime: shiftDayOverride?.signOutTime || rawShift.signOutTime,
      }
    : undefined;

  // Check if a day-specific schedule exists for today (e.g. Sunday vs Wednesday hours)
  const isPerDayMode = policy?.scheduleMode === 'PER_DAY';
  const daySchedule = (!isMultiShift && (isPerDayMode || policy?.daySchedules?.[currentDay]))
    ? policy?.daySchedules?.[currentDay]
    : undefined;

  const enableSignOut = activeShift?.enableSignOut !== undefined
    ? !!activeShift.enableSignOut
    : daySchedule?.enableSignOut !== undefined
      ? !!daySchedule.enableSignOut
      : !!policy?.enableSignOut;
  const signOutTime = activeShift?.signOutTime || daySchedule?.signOutTime || policy?.signOutTime || '17:00';
  const signOutMinutes = parseTimeToMinutes(signOutTime) ?? 1020;
  const signOutTimeFormatted = format12Hour(signOutTime);

  const rawOpenTime = activeShift?.arrivalCutoff || daySchedule?.arrivalCutoff || policy?.arrivalCutoff || '07:00';
  const rawOpenMinutes = parseTimeToMinutes(rawOpenTime) ?? 0;
  const isOvernightShift = Boolean(activeShift && signOutMinutes < rawOpenMinutes);

  const canSignOut = isOvernightShift
    ? enableSignOut && (currentMinutes >= signOutMinutes && currentMinutes < rawOpenMinutes)
    : enableSignOut && currentMinutes >= signOutMinutes;

  // 1. If no policy configured at all, allow sign-in
  if (!policy || (!policy.arrivalCutoff && !policy.lateTolerance && !policy.serviceDays?.length && !policy.daySchedules && !policy.shifts?.length)) {
    return {
      isAllowed: true,
      status: 'UNRESTRICTED',
      attendanceStatus: 'ON_TIME',
      badgeLabel: 'Window Active',
      badgeType: 'active',
      summary: 'Attendance window is unrestricted today.',
      openTimeFormatted: 'Open All Day',
      closeTimeFormatted: 'No Cutoff',
      enableSignOut,
      signOutTimeFormatted,
      canSignOut,
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
        attendanceStatus: 'ON_TIME',
        badgeLabel: 'No Session Scheduled',
        badgeType: 'neutral',
        summary: `Today (${DAY_NAMES[currentDay]}) is not an active attendance day.`,
        openTimeFormatted: '--',
        closeTimeFormatted: '--',
        enableSignOut,
        signOutTimeFormatted,
        canSignOut: false,
        rejectionReason: `No attendance session scheduled for today. Scheduled operating days: ${scheduledNames || 'None'}.`,
      };
    }
  }

  // 3. Time windows (Resolving shift or day-specific schedule if configured)
  const openTime = activeShift?.arrivalCutoff || daySchedule?.arrivalCutoff || policy.arrivalCutoff || '07:00';
  const closeTime = activeShift?.lateTolerance || daySchedule?.lateTolerance || policy.lateTolerance || '07:30';
  // Global Allow Late Check-In applies uniformly across Unified, Per-Day, and Multi-Shift
  const allowLate = policy.allowLateSignIn !== false;

  const openMinutes = parseTimeToMinutes(openTime) ?? 0;
  let closeMinutes = parseTimeToMinutes(closeTime) ?? 1439;
  // Handle overnight shift cutoff & currentMinutes normalization (e.g. 22:00 open -> 06:00 sign-out)
  if (isOvernightShift && closeMinutes < openMinutes) {
    closeMinutes += 1440;
  }
  const effectiveNowMinutes =
    isOvernightShift && currentMinutes < signOutMinutes + 120
      ? currentMinutes + 1440
      : currentMinutes;

  const formattedOpen = format12Hour(openTime);
  const formattedClose = format12Hour(closeTime);

  // If before window open
  if (effectiveNowMinutes < openMinutes) {
    const diff = openMinutes - effectiveNowMinutes;
    return {
      isAllowed: false,
      status: 'BEFORE_WINDOW',
      attendanceStatus: 'ON_TIME',
      badgeLabel: `${activeShift ? `${activeShift.name}: ` : ''}Opens at ${formattedOpen}`,
      badgeType: 'warning',
      summary: `${activeShift ? `${activeShift.name} opens` : 'Sign-in opens'} at ${formattedOpen} (in ${diff} min${diff > 1 ? 's' : ''}).`,
      openTimeFormatted: formattedOpen,
      closeTimeFormatted: formattedClose,
      enableSignOut,
      signOutTimeFormatted,
      canSignOut: false,
      minutesRemaining: diff,
      activeShiftName: activeShift?.name,
      rejectionReason: `Sign-in window is not yet open. It begins at ${formattedOpen}. Current time is ${currentTime12}.`,
    };
  }

  // Within regular active window (ON TIME)
  if (effectiveNowMinutes <= closeMinutes) {
    const remaining = closeMinutes - effectiveNowMinutes;
    return {
      isAllowed: true,
      status: 'WINDOW_OPEN',
      attendanceStatus: 'ON_TIME',
      badgeLabel: `${activeShift ? `${activeShift.name} • ` : 'Window Open • '}${remaining}m left`,
      badgeType: 'active',
      summary: `Active until ${formattedClose} (${remaining} min${remaining > 1 ? 's' : ''} left).`,
      openTimeFormatted: formattedOpen,
      closeTimeFormatted: formattedClose,
      enableSignOut,
      signOutTimeFormatted,
      canSignOut,
      minutesRemaining: remaining,
      activeShiftName: activeShift?.name,
    };
  }

  // Past window close
  if (allowLate) {
    // Late check-in is permitted, marked LATE
    return {
      isAllowed: true,
      status: 'WINDOW_OPEN_LATE',
      attendanceStatus: 'LATE',
      badgeLabel: activeShift ? `${activeShift.name} (Late)` : 'Late Sign-In Active',
      badgeType: 'warning',
      summary: `Official arrival deadline was ${formattedClose}. Clock-in permitted with LATE tag.`,
      openTimeFormatted: formattedOpen,
      closeTimeFormatted: formattedClose,
      enableSignOut,
      signOutTimeFormatted,
      canSignOut,
      activeShiftName: activeShift?.name,
    };
  }

  // Strict cutoff without late tolerance
  return {
    isAllowed: false,
    status: 'PAST_WINDOW',
    attendanceStatus: 'LATE',
    badgeLabel: 'Window Closed (Late)',
    badgeType: 'error',
    summary: `Attendance window closed at ${formattedClose}.`,
    openTimeFormatted: formattedOpen,
    closeTimeFormatted: formattedClose,
    enableSignOut,
    signOutTimeFormatted,
    canSignOut,
    activeShiftName: activeShift?.name,
    rejectionReason: `The sign-in window closed at ${formattedClose}. Late sign-in is not permitted.`,
  };
}
