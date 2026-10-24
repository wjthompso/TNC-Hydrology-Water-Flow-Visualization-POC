import type { ObservationClock } from './creek-data-contract';

/** Dates are read and shown in the same time zone as the time readout. */
const DISPLAY_TIME_ZONE = 'America/Los_Angeles';

/** Inclusive first and last grid slots the time slider spans. */
export interface SlotRange {
  readonly firstIndex: number;
  readonly lastIndex: number;
}

const wallClockFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The Pacific wall-clock reading of an instant, expressed as if it were UTC. */
function wallClockAsUtcMs(timeUtcMs: number): number {
  const parts: Record<string, string> = {};
  for (const part of wallClockFormatter.formatToParts(timeUtcMs)) parts[part.type] = part.value;
  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/** `YYYY-MM-DD`, the format of a date input, for the Pacific day containing the instant. */
export function dateInputValue(timeUtcMs: number): string {
  return new Date(wallClockAsUtcMs(timeUtcMs)).toISOString().slice(0, 10);
}

/** The instant a Pacific day starts. Null when the text is not `YYYY-MM-DD`. */
export function dayStartUtcMs(dateText: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateText);
  if (!match) return null;
  const wallClockMs = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Two passes settle the offset when a daylight-saving change falls inside the day.
  const firstGuess = wallClockMs - (wallClockAsUtcMs(wallClockMs) - wallClockMs);
  return wallClockMs - (wallClockAsUtcMs(firstGuess) - firstGuess);
}

/** The last millisecond of a Pacific day. Null when the text is not `YYYY-MM-DD`. */
export function dayEndUtcMs(dateText: string): number | null {
  if (dayStartUtcMs(dateText) === null) return null;
  const [year, month, day] = dateText.split('-').map(Number);
  const nextDayText = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  const nextDayStart = dayStartUtcMs(nextDayText);
  return nextDayStart === null ? null : nextDayStart - 1;
}

/** Every slot of the record. */
export function fullSlotRange(clock: ObservationClock): SlotRange {
  return { firstIndex: 0, lastIndex: Math.max(0, clock.count - 1) };
}

export function slotRangesEqual(a: SlotRange, b: SlotRange): boolean {
  return a.firstIndex === b.firstIndex && a.lastIndex === b.lastIndex;
}

/**
 * The slots from the start of the start date through the end of the end date,
 * clamped to the record. Null when either date is unreadable or no slot falls inside.
 */
export function slotRangeForDates(
  clock: ObservationClock,
  startDateText: string,
  endDateText: string,
): SlotRange | null {
  const startMs = dayStartUtcMs(startDateText);
  const endMs = dayEndUtcMs(endDateText);
  if (startMs === null || endMs === null) return null;
  const firstIndex = Math.max(0, Math.ceil((startMs - clock.firstUtcMs) / clock.stepMs));
  const lastIndex = Math.min(clock.count - 1, Math.floor((endMs - clock.firstUtcMs) / clock.stepMs));
  return firstIndex <= lastIndex ? { firstIndex, lastIndex } : null;
}
