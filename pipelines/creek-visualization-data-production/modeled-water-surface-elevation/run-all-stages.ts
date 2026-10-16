import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Runs Stages 0–5 in order and forwards every command-line argument (for example
 * `--extent=jalama-gauge-reach`, `--force`, `--water-years=2018-2023`) to each stage.
 * An `&&`-chained npm script would pass those arguments only to its last command.
 * Stops at the first stage that fails and prints per-stage wall-clock time.
 */

const STAGE_FILES = [
  'stage-00-acquire.ts',
  'stage-01-cross-sections.ts',
  'stage-02-rating-curves.ts',
  'stage-03-time-series.ts',
  'stage-04-water-surface-polygons.ts',
  'stage-05-catalog-and-validate.ts',
] as const;

const stageDirectoryPath = path.dirname(fileURLToPath(import.meta.url));
const forwardedArguments = process.argv.slice(2);
const timings: string[] = [];
const startedAt = Date.now();
for (const stageFile of STAGE_FILES) {
  const stageStartedAt = Date.now();
  const result = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', path.join(stageDirectoryPath, stageFile), ...forwardedArguments],
    { stdio: 'inherit' },
  );
  timings.push(`${stageFile.replace(/\.ts$/, '')}: ${((Date.now() - stageStartedAt) / 1000).toFixed(1)} s`);
  if (result.status !== 0) {
    console.error(`Stopped: ${stageFile} exited with ${result.status ?? result.signal}.`);
    process.exitCode = result.status ?? 1;
    break;
  }
}
console.log(`Wall-clock per stage (including process start): ${timings.join(', ')}; total ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
