import { timelineOnlyMode } from './timeline-fixture-request';

/**
 * A timeline-only path skips the 3D scene. A static ArcGIS import here would
 * still download that scene, so the scene entry stays dynamic.
 */
if (timelineOnlyMode(window.location.search, import.meta.env.VITE_TEST_MODE === 'true')) {
  await import('./timeline-fixture-experience');
} else {
  await import('./creek-experience-main');
}
