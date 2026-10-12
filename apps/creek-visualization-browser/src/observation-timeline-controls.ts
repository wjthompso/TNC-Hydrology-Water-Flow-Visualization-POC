import {
  timeAtGridIndex,
  type ObservationClock,
} from './creek-data-contract';

const PLAYBACK_STEP_INTERVAL_MS = 100;

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
}

/**
 * The slider indexes the 15-minute grid, including gap slots.
 * Scrubbing while playback is running keeps playing from the new slot.
 * Play on the last slot restarts at the first slot.
 * Reaching the last slot stops playback and returns the button to Play.
 */
export function bindObservationTimelineControls(
  elements: ObservationTimelineElements,
  clock: ObservationClock,
  openingGridIndex: number,
  onSelectedTime: (timeUtcMs: number) => void,
): void {
  const { playButton, slider, timeReadout } = elements;
  let currentIndex = 0;
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

  playButton.addEventListener('click', () => {
    if (playbackTimer != null) {
      stopPlayback();
      return;
    }
    if (currentIndex >= clock.count - 1) selectIndex(0);
    if (currentIndex >= clock.count - 1) return;
    playbackTimer = window.setInterval(advance, PLAYBACK_STEP_INTERVAL_MS);
    updatePlayButton();
  });

  slider.addEventListener('input', () => {
    const index = Number.parseInt(slider.value, 10);
    if (!Number.isFinite(index)) return;
    selectIndex(index);
    if (playbackTimer != null && currentIndex >= clock.count - 1) stopPlayback();
  });

  selectIndex(openingGridIndex);
}
