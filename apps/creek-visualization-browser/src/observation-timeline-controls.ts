import {
  timeAtGridIndex,
  type ObservationClock,
} from './creek-data-contract';
import { createExperienceLifetime, type ExperienceLifetime } from './experience-lifetime';
import {
  dateInputValue,
  formatDateInputValue,
  fullSlotRange,
  slotRangeForDates,
  slotRangesEqual,
  type SlotRange,
} from './observation-time-range';
import { DEFAULT_PLAYBACK_SPEED, bindPlaybackSpeedMenu } from './playback-speed-menu';

/** One slot per 100 ms. 1× uses this delay. 2× halves it. */
const BASE_PLAYBACK_STEP_INTERVAL_MS = 100;

/** Direction button, speed button, and the speed listbox the button opens. */
export interface PlaybackControlGroup {
  directionButton: HTMLButtonElement;
  speedButton: HTMLButtonElement;
  speedMenu: HTMLElement;
}

/** Reads the playback direction and speed controls from the page. Throws when one is missing. */
export function readPlaybackControlGroup(): PlaybackControlGroup {
  const directionButton = document.getElementById('timeline-direction-btn');
  const speedButton = document.getElementById('timeline-speed-btn');
  const speedMenu = document.getElementById('timeline-speed-menu');
  if (!(directionButton instanceof HTMLButtonElement)) throw new Error('The playback direction button is missing.');
  if (!(speedButton instanceof HTMLButtonElement)) throw new Error('The playback speed button is missing.');
  if (!(speedMenu instanceof HTMLElement)) throw new Error('The playback speed menu is missing.');
  return { directionButton, speedButton, speedMenu };
}

/** Reads the time range controls from the page. Null on pages without them. */
export function readTimeRangeControls(): TimeRangeControls | null {
  const container = document.getElementById('timeline-range');
  const startPicker = document.getElementById('timeline-range-start-picker');
  const endPicker = document.getElementById('timeline-range-end-picker');
  const startDateInput = document.getElementById('timeline-range-start');
  const endDateInput = document.getElementById('timeline-range-end');
  const startDateText = document.getElementById('timeline-range-start-text');
  const endDateText = document.getElementById('timeline-range-end-text');
  const resetButton = document.getElementById('timeline-range-reset');
  const message = document.getElementById('timeline-range-message');
  if (
    !(container instanceof HTMLElement) ||
    !(startPicker instanceof HTMLElement) ||
    !(endPicker instanceof HTMLElement) ||
    !(startDateInput instanceof HTMLInputElement) ||
    !(endDateInput instanceof HTMLInputElement) ||
    !(startDateText instanceof HTMLElement) ||
    !(endDateText instanceof HTMLElement) ||
    !(resetButton instanceof HTMLButtonElement) ||
    !(message instanceof HTMLElement)
  ) {
    return null;
  }
  return {
    container,
    startPicker,
    endPicker,
    startDateInput,
    endDateInput,
    startDateText,
    endDateText,
    resetButton,
    message,
  };
}

/**
 * Opens the browser's calendar. Browsers without `showPicker`, or that refuse it, get focus,
 * and the keyboard still opens the native picker. (A synthetic click here would re-enter this handler.)
 */
function openDatePicker(input: HTMLInputElement): void {
  try {
    input.showPicker();
  } catch {
    input.focus();
  }
}

function stepIntervalMs(speed: number): number {
  return BASE_PLAYBACK_STEP_INTERVAL_MS / speed;
}

const PLAY_ICON =
  '<svg class="ml-0.5 h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5L4 2.5Z"/></svg>';
const PAUSE_ICON =
  '<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="0.75"/><rect x="9.5" y="2.5" width="3" height="11" rx="0.75"/></svg>';

const FORWARD_ICON =
  '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const REVERSE_ICON =
  '<svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>';

type PlaybackDirection = 'forward' | 'reverse';

const observationTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

export function formatObservationTime(timeUtcMs: number): string {
  return observationTimeFormatter.format(timeUtcMs);
}

/** Date pickers that narrow the slider to part of the record. */
export interface TimeRangeControls {
  /** Holds the Full record button and the message; hidden until the controls are bound. */
  container: HTMLElement;
  /** Wrappers of the two date pickers; hidden until the controls are bound. */
  startPicker: HTMLElement;
  endPicker: HTMLElement;
  /** The inputs hold the dates. Their native text is invisible; the text elements below show them. */
  startDateInput: HTMLInputElement;
  endDateInput: HTMLInputElement;
  /** Show each date as "Sep 30, 2017". */
  startDateText: HTMLElement;
  endDateText: HTMLElement;
  resetButton: HTMLButtonElement;
  /** Polite live region for a rejected date. */
  message: HTMLElement;
}

export interface ObservationTimelineElements {
  playButton: HTMLButtonElement;
  slider: HTMLInputElement;
  timeReadout: HTMLElement;
  /** Direction button and speed menu. The timeline works without them. */
  playbackControls?: PlaybackControlGroup;
  timeRangeControls?: TimeRangeControls;
}

export interface ObservationTimelineController {
  /**
   * Moves the slider to the grid slot nearest the time, the same way a scrub
   * does: the readout and the map follow, and running playback keeps going.
   */
  selectTime(timeUtcMs: number): void;
  /** First and last time of the From and To dates now narrowing the slider (the whole record until a person picks dates). */
  readonly rangeUtcMs: readonly [number, number];
  /** Calls the listener each time the From or To range changes. */
  onRangeChange(listener: () => void): void;
}

/**
 * The slider indexes the observation grid, including gap slots.
 * The speed button opens a menu of 0.1×, 0.2×, 0.5×, 1×, 2×, 5×, and 10×. Choosing a speed
 * does not start playback. The page starts at 1×, which steps one slot every 100 ms,
 * so 0.1× steps one slot per second. Play starts at the chosen speed. Pause stops.
 * Changing speed while playback is running keeps playing at the new speed.
 * The direction button starts on forward and flips between forward and reverse.
 * Forward moves the slider up one slot per step. Reverse moves it down one slot per step.
 * Flipping the direction while playback is running keeps playing the other way, without pausing.
 * Forward reaching the last slot of the range, or reverse reaching the first, stops playback
 * and returns the button to Play. Play at that slot restarts from the opposite end of the range:
 * forward restarts at the first slot, reverse at the last.
 * Scrubbing while playback is running keeps playing from the new slot, in the same direction.
 * Time range controls narrow the slider to whole days. The slider, playback in both
 * directions, and Play-restart then use only that range. A selected time outside a new
 * range moves to its nearest edge. Reset restores the whole record.
 * Every step reaches `onSelectedTime` through `selectIndex`, the same path a scrub takes.
 * Ending the `lifetime` stops playback and unbinds every control.
 */
export function bindObservationTimelineControls(
  elements: ObservationTimelineElements,
  clock: ObservationClock,
  openingGridIndex: number,
  onSelectedTime: (timeUtcMs: number) => void,
  lifetime: ExperienceLifetime = createExperienceLifetime(),
): ObservationTimelineController {
  const { playButton, slider, timeReadout, playbackControls, timeRangeControls } = elements;
  const fullRange = fullSlotRange(clock);
  let range: SlotRange = fullRange;
  let currentIndex = 0;
  let selectedSpeed = DEFAULT_PLAYBACK_SPEED;
  let direction: PlaybackDirection = 'forward';
  let playbackTimer: number | null = null;
  const listening = { signal: lifetime.signal };
  const rangeListeners: (() => void)[] = [];
  lifetime.onEnd(() => {
    if (playbackTimer != null) window.clearInterval(playbackTimer);
    playbackTimer = null;
  });

  slider.step = '1';
  const applyRangeToSlider = (): void => {
    slider.min = String(range.firstIndex);
    slider.max = String(range.lastIndex);
  };
  applyRangeToSlider();

  /** Null until the first draw. */
  let drawnPlaying: boolean | null = null;

  const updatePlayButton = (): void => {
    const playing = playbackTimer != null;
    // Every playback slot calls this. Redrawing an unchanged button would replace the icon
    // under the pointer between press and release, and the browser would drop the click.
    if (playing === drawnPlaying) return;
    drawnPlaying = playing;
    const label = playing ? 'Pause' : 'Play';
    // Icon only; aria-label and title carry the name for screen readers and hover.
    playButton.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
    playButton.setAttribute('aria-label', label);
    playButton.title = label;
    playButton.setAttribute('aria-pressed', playing ? 'true' : 'false');
    playButton.disabled = false;
  };

  const selectIndex = (index: number): void => {
    currentIndex = Math.max(range.firstIndex, Math.min(range.lastIndex, index));
    slider.value = String(currentIndex);
    const timeUtcMs = timeAtGridIndex(clock, currentIndex);
    const label = formatObservationTime(timeUtcMs);
    slider.setAttribute('aria-valuetext', label);
    timeReadout.textContent = label;
    updatePlayButton();
    onSelectedTime(timeUtcMs);
  };

  const stopPlayback = (): void => {
    if (playbackTimer == null) return;
    window.clearInterval(playbackTimer);
    playbackTimer = null;
    updatePlayButton();
  };

  /** The slot playback in this direction ends on: the last slot going forward, the first going in reverse. */
  const endIndex = (): number => (direction === 'forward' ? range.lastIndex : range.firstIndex);
  /** The slot a restart begins on: the opposite end of the range. */
  const restartIndex = (): number => (direction === 'forward' ? range.firstIndex : range.lastIndex);
  const atPlaybackEnd = (): boolean => currentIndex === endIndex();
  const nextIndex = (): number => currentIndex + (direction === 'forward' ? 1 : -1);

  const advance = (): void => {
    if (atPlaybackEnd()) {
      stopPlayback();
      return;
    }
    selectIndex(nextIndex());
    if (atPlaybackEnd()) stopPlayback();
  };

  const startPlayback = (): void => {
    if (playbackTimer != null) window.clearInterval(playbackTimer);
    playbackTimer = window.setInterval(advance, stepIntervalMs(selectedSpeed));
    updatePlayButton();
  };

  playButton.addEventListener('click', () => {
    if (playbackTimer != null) {
      stopPlayback();
      return;
    }
    if (atPlaybackEnd()) selectIndex(restartIndex());
    if (atPlaybackEnd()) return;
    startPlayback();
  }, listening);

  if (playbackControls) {
    const { directionButton, speedButton, speedMenu } = playbackControls;

    const drawDirection = (): void => {
      directionButton.innerHTML = direction === 'forward' ? FORWARD_ICON : REVERSE_ICON;
      const label = `Playback direction: ${direction}`;
      directionButton.setAttribute('aria-label', label);
      directionButton.title = label;
    };

    directionButton.addEventListener('click', () => {
      direction = direction === 'forward' ? 'reverse' : 'forward';
      drawDirection();
      // Running playback keeps going the other way. At the edge it was heading away from, it has nowhere to go.
      if (playbackTimer != null && atPlaybackEnd()) stopPlayback();
    }, listening);
    drawDirection();

    bindPlaybackSpeedMenu(
      { button: speedButton, menu: speedMenu },
      selectedSpeed,
      (speed) => {
        selectedSpeed = speed;
        if (playbackTimer != null) startPlayback();
      },
      lifetime.signal,
    );
  }

  const scrubToIndex = (index: number): void => {
    selectIndex(index);
    if (playbackTimer != null && atPlaybackEnd()) stopPlayback();
  };

  slider.addEventListener('input', () => {
    const index = Number.parseInt(slider.value, 10);
    if (!Number.isFinite(index)) return;
    scrubToIndex(index);
  }, listening);

  selectIndex(openingGridIndex);

  if (timeRangeControls) {
    const {
      container,
      startPicker,
      endPicker,
      startDateInput,
      endDateInput,
      startDateText,
      endDateText,
      resetButton,
      message,
    } = timeRangeControls;
    const firstDate = dateInputValue(timeAtGridIndex(clock, fullRange.firstIndex));
    const lastDate = dateInputValue(timeAtGridIndex(clock, fullRange.lastIndex));

    // Native pickers grey out days with no data, so most bad dates cannot be chosen.
    for (const input of [startDateInput, endDateInput]) {
      input.min = firstDate;
      input.max = lastDate;
    }

    const showRange = (): void => {
      startDateInput.value = dateInputValue(timeAtGridIndex(clock, range.firstIndex));
      endDateInput.value = dateInputValue(timeAtGridIndex(clock, range.lastIndex));
      startDateText.textContent = formatDateInputValue(startDateInput.value);
      endDateText.textContent = formatDateInputValue(endDateInput.value);
      resetButton.hidden = slotRangesEqual(range, fullRange);
    };

    const setRange = (next: SlotRange): void => {
      range = next;
      applyRangeToSlider();
      for (const listener of rangeListeners) listener();
      showRange();
      // Moves the selection to the nearest edge when the new range excludes it.
      scrubToIndex(currentIndex);
    };

    const applyDateInputs = (): void => {
      const next = slotRangeForDates(clock, startDateInput.value, endDateInput.value);
      if (!next) {
        message.textContent = 'Pick a start date on or before the end date, inside the record.';
        showRange();
        return;
      }
      message.textContent = '';
      setRange(next);
    };

    startDateInput.addEventListener('change', applyDateInputs, listening);
    endDateInput.addEventListener('change', applyDateInputs, listening);
    // The input sits invisibly over the formatted date, so a click anywhere on the picker opens the calendar.
    startDateInput.addEventListener('click', () => openDatePicker(startDateInput), listening);
    endDateInput.addEventListener('click', () => openDatePicker(endDateInput), listening);
    resetButton.addEventListener('click', () => {
      message.textContent = '';
      setRange(fullRange);
    }, listening);

    showRange();
    startPicker.hidden = false;
    endPicker.hidden = false;
    container.hidden = false;
  }

  return {
    get rangeUtcMs() {
      return [timeAtGridIndex(clock, range.firstIndex), timeAtGridIndex(clock, range.lastIndex)] as const;
    },
    onRangeChange(listener) {
      rangeListeners.push(listener);
    },
    selectTime(timeUtcMs) {
      if (!Number.isFinite(timeUtcMs)) return;
      scrubToIndex(Math.round((timeUtcMs - clock.firstUtcMs) / clock.stepMs));
    },
  };
}
