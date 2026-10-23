import {
  timeAtGridIndex,
  type ObservationClock,
} from './creek-data-contract';
import {
  dateInputValue,
  fullSlotRange,
  slotRangeForDates,
  slotRangesEqual,
  type SlotRange,
} from './observation-time-range';

/** One slot per 100 ms. 1× uses this delay. 2× halves it. */
const BASE_PLAYBACK_STEP_INTERVAL_MS = 100;

export const PLAYBACK_SPEED_BUTTONS = [
  { speed: 0.5, elementId: 'timeline-speed-0-5x' },
  { speed: 1, elementId: 'timeline-speed-1x' },
  { speed: 2, elementId: 'timeline-speed-2x' },
  { speed: 5, elementId: 'timeline-speed-5x' },
  { speed: 10, elementId: 'timeline-speed-10x' },
] as const;

export interface PlaybackSpeedControl {
  readonly speed: number;
  readonly button: HTMLButtonElement;
}

export function readPlaybackSpeedButtons(): PlaybackSpeedControl[] {
  return PLAYBACK_SPEED_BUTTONS.map(({ speed, elementId }) => {
    const button = document.getElementById(elementId);
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error(`The ${speed} times speed button is missing.`);
    }
    return { speed, button };
  });
}

/** Reads the time range block from the page. Null on pages without it, such as the timeline test page. */
export function readTimeRangeControls(): TimeRangeControls | null {
  const container = document.getElementById('timeline-range');
  const startDateInput = document.getElementById('timeline-range-start');
  const endDateInput = document.getElementById('timeline-range-end');
  const resetButton = document.getElementById('timeline-range-reset');
  const message = document.getElementById('timeline-range-message');
  if (
    !(container instanceof HTMLElement) ||
    !(startDateInput instanceof HTMLInputElement) ||
    !(endDateInput instanceof HTMLInputElement) ||
    !(resetButton instanceof HTMLButtonElement) ||
    !(message instanceof HTMLElement)
  ) {
    return null;
  }
  return { container, startDateInput, endDateInput, resetButton, message };
}

function stepIntervalMs(speed: number): number {
  return BASE_PLAYBACK_STEP_INTERVAL_MS / speed;
}

const PLAY_ICON =
  '<svg class="ml-0.5 h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5L4 2.5Z"/></svg>';
const PAUSE_ICON =
  '<svg class="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3.5" y="2.5" width="3" height="11" rx="0.75"/><rect x="9.5" y="2.5" width="3" height="11" rx="0.75"/></svg>';

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
  /** Whole block; hidden until the controls are bound. */
  container: HTMLElement;
  startDateInput: HTMLInputElement;
  endDateInput: HTMLInputElement;
  resetButton: HTMLButtonElement;
  /** Polite live region for a rejected date. */
  message: HTMLElement;
}

export interface ObservationTimelineElements {
  playButton: HTMLButtonElement;
  slider: HTMLInputElement;
  timeReadout: HTMLElement;
  speedButtons?: readonly PlaybackSpeedControl[];
  timeRangeControls?: TimeRangeControls;
}

export interface ObservationTimelineController {
  /**
   * Moves the slider to the grid slot nearest the time, the same way a scrub
   * does: the readout and the map follow, and running playback keeps going.
   */
  selectTime(timeUtcMs: number): void;
}

/**
 * The slider indexes the 15-minute grid, including gap slots.
 * Speed buttons choose 0.5×, 1×, 2×, 5×, or 10× and do not start playback.
 * The chosen speed uses a brighter button color. The page starts at 1×.
 * 1× steps one slot every 100 ms. Play starts at the chosen speed. Pause stops.
 * Changing speed while playback is running keeps playing at the new speed.
 * Scrubbing while playback is running keeps playing from the new slot.
 * Play on the last slot restarts at the first slot.
 * Reaching the last slot stops playback and returns the button to Play.
 * Time range controls narrow the slider to whole days. The slider, playback,
 * and Play-restart then use only that range. A selected time outside a new
 * range moves to its nearest edge. Reset restores the whole record.
 */
export function bindObservationTimelineControls(
  elements: ObservationTimelineElements,
  clock: ObservationClock,
  openingGridIndex: number,
  onSelectedTime: (timeUtcMs: number) => void,
): ObservationTimelineController {
  const { playButton, slider, timeReadout, speedButtons = [], timeRangeControls } = elements;
  const fullRange = fullSlotRange(clock);
  let range: SlotRange = fullRange;
  let currentIndex = 0;
  let selectedSpeed = 1;
  let playbackTimer: number | null = null;

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

  const advance = (): void => {
    if (currentIndex >= range.lastIndex) {
      stopPlayback();
      return;
    }
    selectIndex(currentIndex + 1);
    if (currentIndex >= range.lastIndex) stopPlayback();
  };

  const updateSpeedButtons = (): void => {
    for (const { speed, button } of speedButtons) {
      button.setAttribute('aria-pressed', speed === selectedSpeed ? 'true' : 'false');
    }
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
    if (currentIndex >= range.lastIndex) selectIndex(range.firstIndex);
    if (currentIndex >= range.lastIndex) return;
    startPlayback();
  });

  for (const { speed, button } of speedButtons) {
    button.addEventListener('click', () => {
      selectedSpeed = speed;
      updateSpeedButtons();
      if (playbackTimer != null) startPlayback();
    });
  }

  updateSpeedButtons();

  const scrubToIndex = (index: number): void => {
    selectIndex(index);
    if (playbackTimer != null && currentIndex >= range.lastIndex) stopPlayback();
  };

  slider.addEventListener('input', () => {
    const index = Number.parseInt(slider.value, 10);
    if (!Number.isFinite(index)) return;
    scrubToIndex(index);
  });

  selectIndex(openingGridIndex);

  if (timeRangeControls) {
    const { container, startDateInput, endDateInput, resetButton, message } = timeRangeControls;
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
      resetButton.hidden = slotRangesEqual(range, fullRange);
    };

    const setRange = (next: SlotRange): void => {
      range = next;
      applyRangeToSlider();
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

    startDateInput.addEventListener('change', applyDateInputs);
    endDateInput.addEventListener('change', applyDateInputs);
    resetButton.addEventListener('click', () => {
      message.textContent = '';
      setRange(fullRange);
    });

    showRange();
    container.hidden = false;
  }

  return {
    selectTime(timeUtcMs) {
      if (!Number.isFinite(timeUtcMs)) return;
      scrubToIndex(Math.round((timeUtcMs - clock.firstUtcMs) / clock.stepMs));
    },
  };
}
