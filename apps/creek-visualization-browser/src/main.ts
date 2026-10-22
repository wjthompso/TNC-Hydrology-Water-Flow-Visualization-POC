import { timelineOnlyMode } from './timeline-fixture-request';

/**
 * A timeline-only path skips the 3D scene. A static ArcGIS import here would
 * still download that scene, so the scene entry stays dynamic.
 */
try {
  if (timelineOnlyMode(window.location.search, import.meta.env.VITE_TEST_MODE === 'true')) {
    await import('./timeline-fixture-experience');
  } else {
    await import('./creek-experience-main');
  }
} catch (error: unknown) {
  // A module that throws while loading (for example, an invalid
  // VITE_CREEK_DATA_SOURCE) never reaches startExperience, which would leave
  // "Loading observed water…" on screen with no error and no network request.
  console.error(error);
  document.getElementById('loading-overlay')?.remove();
  const errorPanel = document.getElementById('experience-error');
  if (errorPanel) {
    errorPanel.textContent = error instanceof Error ? error.message : 'The experience could not be loaded.';
    errorPanel.classList.remove('hidden');
  }
}
