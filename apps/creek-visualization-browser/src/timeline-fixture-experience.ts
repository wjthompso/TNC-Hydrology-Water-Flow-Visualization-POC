import {
  OBSERVATION_GRID_STEP_MS,
  type ObservationClock,
} from './creek-data-contract';
import {
  bindObservationTimelineControls,
  readPlaybackSpeedButtons,
} from './observation-timeline-controls';
import { timelineOnlyMode } from './timeline-fixture-request';

/** Room for a one-second 10× run, about 100 slots, with space left over. */
const FIXTURE_SLOT_COUNT = 500;

const fixtureClock: ObservationClock = {
  firstUtcMs: Date.UTC(2026, 0, 1),
  stepMs: OBSERVATION_GRID_STEP_MS,
  count: FIXTURE_SLOT_COUNT,
};

void startTimelineExperience();

async function startTimelineExperience(): Promise<void> {
  try {
    const playButton = document.getElementById('timeline-play-btn');
    const slider = document.getElementById('timeline-slider');
    const timeReadout = document.getElementById('timeline-readout');
    if (!(playButton instanceof HTMLButtonElement)) throw new Error('The play button is missing.');
    if (!(slider instanceof HTMLInputElement)) throw new Error('The time slider is missing.');
    if (!(timeReadout instanceof HTMLElement)) throw new Error('The time readout is missing.');

    const mode = timelineOnlyMode(window.location.search, import.meta.env.VITE_TEST_MODE === 'true');
    const speedButtons = readPlaybackSpeedButtons();
    if (mode === 'opening') {
      const { loadPublishedCreekVisualizationData } = await import('./http-data-contract-loader');
      const data = await loadPublishedCreekVisualizationData();
      bindObservationTimelineControls(
        { playButton, slider, timeReadout, speedButtons },
        data.clock,
        data.openingGridIndex,
        () => {},
      );
    } else {
      bindObservationTimelineControls(
        { playButton, slider, timeReadout, speedButtons },
        fixtureClock,
        0,
        () => {},
      );
    }
    document.getElementById('loading-overlay')?.remove();
  } catch (error: unknown) {
    console.error(error);
    const message = error instanceof Error ? error.message : 'The timeline could not be started.';
    const errorElement = document.getElementById('experience-error');
    if (errorElement) {
      errorElement.textContent = message;
      errorElement.classList.remove('hidden');
    }
    document.getElementById('loading-overlay')?.remove();
  }
}
