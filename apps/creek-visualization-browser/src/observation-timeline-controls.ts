import {
  timeAtGridIndex,
  type ObservationClock,
} from './creek-data-contract';

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

function stepIntervalMs(speed: number): number {
  return BASE_PLAYBACK_STEP_INTERVAL_MS / speed;
}

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

export interface ObservationTimelineElements {
  playButton: HTMLButtonElement;
  slider: HTMLInputElement;
  timeReadout: HTMLElement;
  speedButtons?: readonly PlaybackSpeedControl[];
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
 */
export function bindObservationTimelineControls(
  elements: ObservationTimelineElements,
  clock: ObservationClock,
  openingGridIndex: number,
  onSelectedTime: (timeUtcMs: number) => void,
): ObservationTimelineController {
  const { playButton, slider, timeReadout, speedButtons = [] } = elements;
  let currentIndex = 0;
  let selectedSpeed = 1;
  let playbackTimer: number | null = null;

  slider.min = '0';
  slider.max = String(Math.max(0, clock.count - 1));
  slider.step = '1';

  const updatePlayButton = (): void => {
    const playing = playbackTimer != null;
    const label = playing ? 'Pause' : 'Play';
    playButton.textContent = label;
    playButton.setAttribute('aria-label', label);
    playButton.setAttribute('aria-pressed', playing ? 'true' : 'false');
    playButton.disabled = false;
  };

  const selectIndex = (index: number): void => {
    const lastIndex = Math.max(0, clock.count - 1);
    currentIndex = Math.max(0, Math.min(lastIndex, index));
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
    if (currentIndex >= clock.count - 1) {
      stopPlayback();
      return;
    }
    selectIndex(currentIndex + 1);
    if (currentIndex >= clock.count - 1) stopPlayback();
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
    if (currentIndex >= clock.count - 1) selectIndex(0);
    if (currentIndex >= clock.count - 1) return;
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
    if (playbackTimer != null && currentIndex >= clock.count - 1) stopPlayback();
  };

  slider.addEventListener('input', () => {
    const index = Number.parseInt(slider.value, 10);
    if (!Number.isFinite(index)) return;
    scrubToIndex(index);
  });

  selectIndex(openingGridIndex);

  return {
    selectTime(timeUtcMs) {
      if (!Number.isFinite(timeUtcMs)) return;
      scrubToIndex(Math.round((timeUtcMs - clock.firstUtcMs) / clock.stepMs));
    },
  };
}
