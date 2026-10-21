import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { normalizePlaywrightResults } from '../tests/support/reporting/playwright-results.ts';
import { catalogResultState } from '../tests/support/reporting/result-state.ts';
import {
  requiredGateDefinitionFingerprint,
  testDefinitionFingerprint,
} from '../tests/support/reporting/test-definition-fingerprint.ts';

const catalogHost = '127.0.0.1';
const defaultCatalogPort = 4174;
const maxCatalogPortAttempts = 100;

const root = process.cwd();
const resultDirectory = path.join(root, '.test-results');
const testCatalog = JSON.parse(
  await readFile(path.join(root, 'tests/support/catalog/test-catalog.json'), 'utf8'),
);

async function readLatest() {
  try {
    return JSON.parse(await readFile(path.join(resultDirectory, 'latest.json'), 'utf8'));
  } catch {
    return { tests: {}, gateStatus: 'unexecuted' };
  }
}

const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const recordedExecutionStates = new Set([
  'passed',
  'failed',
  'skipped',
  'quarantined',
  'inconclusive',
]);

export function recordedExecutionState(latest) {
  const state = latest?.state;
  return recordedExecutionStates.has(state) ? state : null;
}

export function humanFacingCatalogResult(test, feature, latest) {
  const recorded = recordedExecutionState(latest);
  const definitionCurrent =
    typeof latest?.definitionFingerprint === 'string' &&
    latest.definitionFingerprint === testDefinitionFingerprint(test);
  const lifecycle = feature?.lifecycle ?? 'not-applicable';
  const primary = catalogResultState(
    definitionCurrent ? recorded : null,
    lifecycle,
    test.enforcement,
  );
  const staleExecution = !definitionCurrent && recorded ? recorded : null;
  return {
    lifecycle,
    primary,
    lastExecution: staleExecution ?? (recorded && recorded !== primary ? recorded : null),
    stale: Boolean(staleExecution),
  };
}

function currentGatePresentation(latestResults) {
  const stored =
    typeof latestResults?.gateStatus === 'string' ? latestResults.gateStatus : 'unexecuted';
  const definitionCurrent =
    typeof latestResults?.requiredGateDefinitionFingerprint === 'string' &&
    latestResults.requiredGateDefinitionFingerprint ===
      requiredGateDefinitionFingerprint(testCatalog.tests);
  if (definitionCurrent) {
    return { primary: stored, staleStored: null };
  }
  return {
    primary: 'unexecuted',
    staleStored: recordedExecutionStates.has(stored) ? stored : null,
  };
}

function field(label, value) {
  return `<span><span class="field-label">${escapeHtml(label)}</span> ${escapeHtml(value)}</span>`;
}

function statusLabel(primary) {
  const labels = {
    passed: 'Passed',
    failed: 'Failed',
    skipped: 'Skipped',
    quarantined: 'Quarantined',
    inconclusive: 'Inconclusive',
    disabled: 'Disabled',
    deprecated: 'Deprecated',
    retired: 'Retired',
    unexecuted: 'Unexecuted',
  };
  return labels[primary] ?? primary;
}

function statusWord(primary) {
  const status = typeof primary === 'string' ? primary : 'unexecuted';
  const className =
    status === 'passed' ? 'word-passed' : status === 'failed' ? 'word-failed' : '';
  const classAttribute = className ? ` class="${className}"` : '';
  return `<span${classAttribute}>${escapeHtml(statusLabel(status))}</span>`;
}

function latestRunTestCount(latestResults) {
  if (Array.isArray(latestResults?.lastSelectedTestIds)) {
    return latestResults.lastSelectedTestIds.length;
  }
  // Older result files omit lastSelectedTestIds. Tests stamped at generatedAt belong to that run.
  const generatedAt = latestResults?.generatedAt;
  const tests = latestResults?.tests;
  if (typeof generatedAt !== 'string' || tests === null || typeof tests !== 'object') {
    return 0;
  }
  return Object.values(tests).filter(
    (entry) => entry && typeof entry === 'object' && entry.timestamp === generatedAt,
  ).length;
}

function latestRunSummary(latestResults) {
  const command =
    typeof latestResults?.lastCommand === 'string' ? latestResults.lastCommand : '';
  if (!command) {
    return '<p class="summary">Latest run: none</p>';
  }
  const parts = [escapeHtml(command)];
  const selector = latestResults?.lastSelector;
  if (typeof selector === 'string' && selector.length > 0) {
    parts.push(escapeHtml(selector));
  }
  const count = latestRunTestCount(latestResults);
  parts.push(`${count} ${count === 1 ? 'test' : 'tests'}`);
  parts.push(statusWord(latestResults.lastCommandStatus));
  parts.push(escapeHtml(formatWallClock(latestResults.lastCommandDurationMs)));
  return `<p class="summary">Latest run: ${parts.join(' · ')}</p>`;
}

function releaseGateSummary(latestResults, gate) {
  const stale = gate.staleStored
    ? ` Earlier stored result: ${escapeHtml(statusLabel(gate.staleStored))} (stale required-test definitions).`
    : '';
  const command = latestResults?.lastCommand;
  const notRerun =
    typeof command === 'string' && command !== 'gate'
      ? ' This command did not rerun the release gate.'
      : '';
  return `<p class="summary summary-last">Release gate: ${statusWord(gate.primary)}.${stale}${notRerun}</p>`;
}

function statusTagClass(primary) {
  if (primary === 'passed') return 'tag-passed';
  if (primary === 'failed') return 'tag-failed';
  return 'tag-neutral';
}

function heading(text, identifier) {
  return `<span class="identifier">${escapeHtml(identifier)}</span>&nbsp;<span class="heading-text">${escapeHtml(text)}</span>`;
}

function formatDuration(milliseconds) {
  const tenthsOfASecond = Math.round(milliseconds / 100);
  const seconds = (tenthsOfASecond / 10).toFixed(1);
  return `${milliseconds} ms (${seconds} s)`;
}

function formatWallClock(milliseconds) {
  if (typeof milliseconds !== 'number' || !Number.isFinite(milliseconds) || milliseconds < 0) {
    return 'duration unavailable';
  }
  if (milliseconds < 60_000) {
    const tenths = Math.round(milliseconds / 100) / 10;
    return `${tenths.toFixed(1)} s`;
  }
  const roundedSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return `${minutes} min ${seconds} s`;
}

function formatSeconds(milliseconds) {
  return `${(milliseconds / 1000).toFixed(1)} s`;
}

function resultMark(primary) {
  if (primary === 'passed') return { symbol: '✓', label: 'Passed', className: 'mark-passed' };
  if (primary === 'failed') return { symbol: '✕', label: 'Failed', className: 'mark-failed' };
  return null;
}

function disclosure(title, body) {
  return `<details class="methodology">
      <summary>${escapeHtml(title)}</summary>
      <p>${escapeHtml(body)}</p>
    </details>`;
}

function methodologyDetails(methodology) {
  return disclosure('Test methodology', methodology);
}

function bugCheckBadge(test) {
  if (!test.regression) return '';
  return '<span class="tag tag-bug-check">Bug Check</span>';
}

function testDisclosures(test) {
  const methodology = methodologyDetails(test.methodology);
  if (!test.regression) return methodology;
  return `${methodology}
    ${disclosure('Root Cause Analysis', test.rootCauseAnalysis ?? '')}`;
}

function passedAfterRetry(latest, primary) {
  return primary === 'passed' && latest?.passedAfterRetry === true;
}

function retryAttemptDetails(latest, primary) {
  if (!passedAfterRetry(latest, primary)) return '';
  const attempts = Array.isArray(latest.failedAttempts) ? latest.failedAttempts : [];
  const rows = attempts
    .map((attempt) => {
      const artifacts =
        Array.isArray(attempt.artifacts) && attempt.artifacts.length
          ? attempt.artifacts.join(', ')
          : 'none';
      return `<p>Attempt ${escapeHtml(attempt.attempt)}: ${escapeHtml(attempt.status)}</p>
      <p class="retry-error">${escapeHtml(attempt.errorMessage ?? '')}</p>
      <p>Artifacts: ${escapeHtml(artifacts)}</p>`;
    })
    .join('');
  return `<details class="methodology">
      <summary>Passed after retry</summary>
      ${rows}
    </details>`;
}

// ---------------------------------------------------------------------------
// Error logs: why a test did not pass, readable by a person and copyable for an LLM.
// ---------------------------------------------------------------------------

/** A stored result that did not pass, or passed only after a failed attempt. */
function hasFailureEvidence(latest) {
  if (!latest || typeof latest !== 'object') return false;
  return latest.state === 'failed' || latest.state === 'inconclusive' || latest.passedAfterRetry === true;
}

/** Results recorded before error logs existed fall back to their last failed-attempt record. */
function failureLogFromFailedAttempts(latest) {
  const attempts = Array.isArray(latest?.failedAttempts) ? latest.failedAttempts : [];
  const last = attempts.at(-1);
  if (!last) return null;
  const artifacts = Array.isArray(last.artifacts) ? last.artifacts : [];
  return {
    attempt: last.attempt,
    status: last.status,
    durationMs: last.durationMs,
    errorMessage: last.errorMessage ?? '',
    errorLocation: last.errorLocation,
    stdoutTail: last.stdoutTail,
    stderrTail: last.stderrTail,
    screenshotPath: artifacts.find((artifact) => artifact.endsWith('.png')),
    tracePath: artifacts.find((artifact) => artifact.endsWith('trace.zip')),
    recordedAt: latest.timestamp,
    reconstructed: true,
  };
}

/**
 * Older browser results have no stored error log. Rebuild one from the newest raw
 * Playwright report written no later than that result, using the runner's own parser.
 */
async function reconstructMissingFailureLogs(latestTests) {
  const missing = testCatalog.tests.filter((test) => {
    const result = latestTests[test.id];
    return hasFailureEvidence(result) && !result.failureLog && test.environment === 'browser';
  });
  if (!missing.length) return;

  let reportNames;
  try {
    reportNames = (await readdir(resultDirectory)).filter((name) =>
      /^raw-playwright-.+\.json$/.test(name),
    );
  } catch {
    return;
  }
  const reports = await Promise.all(
    reportNames.map(async (name) => ({
      name,
      modifiedMs: (await stat(path.join(resultDirectory, name))).mtimeMs,
    })),
  );
  reports.sort((first, second) => second.modifiedMs - first.modifiedMs);

  for (const report of reports.slice(0, 40)) {
    const pending = missing.filter((test) => !latestTests[test.id].failureLog);
    if (!pending.length) return;
    let raw;
    try {
      raw = JSON.parse(await readFile(path.join(resultDirectory, report.name), 'utf8'));
    } catch {
      continue;
    }
    const normalized = normalizePlaywrightResults(raw, pending, false, root);
    for (const candidate of normalized) {
      const stored = latestTests[candidate.id];
      const writtenBeforeResult = report.modifiedMs <= Date.parse(stored.timestamp) + 60_000;
      const sameOutcome =
        candidate.state === stored.state &&
        Boolean(candidate.passedAfterRetry) === Boolean(stored.passedAfterRetry);
      if (candidate.failureLog && writtenBeforeResult && sameOutcome) {
        stored.failureLog = {
          ...candidate.failureLog,
          runId: report.name.replace(/^raw-playwright-/, '').replace(/\.json$/, ''),
          recordedAt: stored.timestamp,
          reconstructed: true,
        };
      }
    }
  }
}

function effectiveFailureLog(latest) {
  if (!hasFailureEvidence(latest)) return null;
  return latest.failureLog ?? failureLogFromFailedAttempts(latest);
}

/** Artifact paths are repository-relative under .test-results/; the server serves that folder. */
function artifactUrl(repoRelativePath) {
  return `/${repoRelativePath.replace(/^\.test-results\//, '').split('/').map(encodeURIComponent).join('/')}`;
}

function resultPhrase(latest, log) {
  if (latest.state === 'passed') {
    return `passed after retry; this log is from failed attempt ${log.attempt} (${log.status})`;
  }
  return log.status && log.status !== latest.state ? `${latest.state} (${log.status})` : latest.state;
}

/** A Markdown fence longer than any backtick run inside the text. */
function fenced(text, language = 'text') {
  const longestRun = Math.max(2, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longestRun + 1);
  return `${fence}${language}\n${text}\n${fence}`;
}

function rerunCommand(test) {
  return `npm run test:id -- ${test.id}`;
}

/** One self-contained Markdown block for pasting into an LLM conversation. */
function failureMarkdown(test, latest, log) {
  const lines = [
    `## Test failure: ${test.id} — ${test.name}`,
    '',
    `- Result: ${resultPhrase(latest, log)}`,
    `- Duration: ${latest.durationMs} ms (final attempt) / budget ${test.durationBudgetMs} ms`,
    `- Attempt shown: ${log.attempt}`,
    `- Recorded: ${log.recordedAt ?? latest.timestamp}`,
    `- Command that produced this result: ${log.command ? `\`${log.command}\`` : 'not recorded'}`,
    `- Run id: ${log.runId ?? 'not recorded'}`,
    `- Source file: \`${test.sourceFile}\``,
    `- Rerun: \`${rerunCommand(test)}\``,
    '',
    '### Test methodology',
    '',
    test.methodology,
    '',
    '### Error',
    '',
    fenced(log.errorMessage || '(no error message recorded)'),
  ];
  if (log.errorLocation) lines.push('', `Location: \`${log.errorLocation}\``);
  if (log.stackLines?.length) lines.push('', '### Stack (repository frames)', '', fenced(log.stackLines.join('\n')));
  if (log.stdoutTail) lines.push('', '### stdout (tail)', '', fenced(log.stdoutTail));
  if (log.stderrTail) lines.push('', '### stderr (tail)', '', fenced(log.stderrTail));
  const artifacts = [
    log.screenshotPath && `- Screenshot: \`${log.screenshotPath}\``,
    log.tracePath &&
      `- Trace: \`${log.tracePath}\` (open with \`npx playwright show-trace ${log.tracePath}\`)`,
    log.errorContextPath && `- Page snapshot at failure: \`${log.errorContextPath}\``,
  ].filter(Boolean);
  if (artifacts.length) lines.push('', '### Artifacts', '', ...artifacts);
  return lines.join('\n');
}

function monospaceBlock(label, text) {
  if (!text) return '';
  return `<p class="log-label">${escapeHtml(label)}</p>
      <pre class="log-block">${escapeHtml(text)}</pre>`;
}

function launchButton(action, test, enabled, disabledReason, label) {
  const disabled = enabled ? '' : ` disabled title="${escapeHtml(disabledReason)}"`;
  return `<button type="button" class="log-button" data-launch="${action}" data-test-id="${escapeHtml(test.id)}"${disabled}>${escapeHtml(label)}</button>`;
}

function errorLogDetails(test, latest) {
  const log = effectiveFailureLog(latest);
  if (!log) return '';
  const header = [
    field('Result', resultPhrase(latest, log)),
    field('Duration', `${formatDuration(latest.durationMs)} / budget ${formatDuration(test.durationBudgetMs)}`),
    field('Attempt', log.attempt),
    field('When', log.recordedAt ?? latest.timestamp),
    field('Command', log.command ?? 'not recorded'),
    field('Run id', log.runId ?? 'not recorded'),
    field('Rerun', rerunCommand(test)),
  ];
  const artifactLinks = [
    log.screenshotPath &&
      `<a href="${escapeHtml(artifactUrl(log.screenshotPath))}" target="_blank" rel="noopener">Screenshot</a> <span class="log-path">${escapeHtml(log.screenshotPath)}</span>`,
    log.tracePath &&
      `<a href="${escapeHtml(artifactUrl(log.tracePath))}">Trace (download)</a> <span class="log-path">${escapeHtml(log.tracePath)}</span>`,
    log.errorContextPath &&
      `<a href="${escapeHtml(artifactUrl(log.errorContextPath))}" target="_blank" rel="noopener">Page snapshot at failure</a> <span class="log-path">${escapeHtml(log.errorContextPath)}</span>`,
  ].filter(Boolean);
  return `<details class="methodology error-logs">
      <summary>Error logs</summary>
      <div class="log-body">
        <div class="log-actions">
          <button type="button" class="log-button" data-copy-llm>Copy for LLM</button>
          ${launchButton('open-trace', test, Boolean(log.tracePath), 'No trace was saved for this attempt.', 'Open trace')}
          <span class="log-status" role="status" aria-live="polite"></span>
        </div>
        <pre class="llm-markdown log-block" hidden>${escapeHtml(failureMarkdown(test, latest, log))}</pre>
        <p class="log-title"><span class="identifier">${escapeHtml(test.id)}</span>&nbsp;${escapeHtml(test.name)}</p>
        ${header.map((line) => `<p class="log-meta">${line}</p>`).join('')}
        ${log.reconstructed ? '<p class="log-meta">Rebuilt from an older stored result; some fields were not recorded.</p>' : ''}
        ${monospaceBlock('Error', log.errorMessage || '(no error message recorded)')}
        ${log.errorLocation ? `<p class="log-label">Location</p><pre class="log-block">${escapeHtml(log.errorLocation)}</pre>` : ''}
        ${monospaceBlock('Stack (repository frames)', log.stackLines?.join('\n'))}
        ${monospaceBlock('stdout (tail)', log.stdoutTail)}
        ${monospaceBlock('stderr (tail)', log.stderrTail)}
        ${artifactLinks.length ? `<p class="log-label">Artifacts</p>${artifactLinks.map((link) => `<p class="log-artifact">${link}</p>`).join('')}` : ''}
      </div>
    </details>`;
}

function testCard(test, feature, latestResults) {
  const latest = latestResults[test.id];
  const display = humanFacingCatalogResult(test, feature, latest);
  const lines = [
    field('Category', test.category),
    field('Lifecycle', display.lifecycle),
    field('Enforcement', test.enforcement),
    field('Scope', test.scope),
    field('Environment', test.environment),
    field('Browser mode', test.browserMode),
    field('Budget', formatDuration(test.durationBudgetMs)),
  ];
  if (latest && !display.stale) {
    lines.push(field('Duration', formatDuration(latest.durationMs)));
    if (typeof latest.totalDurationMs === 'number' && latest.totalDurationMs !== latest.durationMs) {
      lines.push(field('Total duration', formatDuration(latest.totalDurationMs)));
    }
    lines.push(field('Recorded', latest.timestamp));
  }
  if (display.stale && display.lastExecution) {
    lines.push(
      `Last execution: ${escapeHtml(display.lastExecution)} (stale test definition).`,
    );
  } else if (display.lastExecution) {
    lines.push(`Last execution: ${escapeHtml(display.lastExecution)}`);
  }
  const measured = latest && !display.stale ? formatSeconds(latest.durationMs) : '—';
  const mark = resultMark(display.primary);
  const isBrowserTest = test.environment === 'browser';
  return `<details class="test-row">
    <summary>
      <span class="scan"><span class="identifier">${escapeHtml(test.id)}</span>&nbsp;<span class="behavior">${escapeHtml(test.name)}</span></span>
      <span class="result-column">
        <span class="tags">
          <span class="timing">${escapeHtml(measured)} / ${escapeHtml(formatSeconds(test.durationBudgetMs))}</span>
          ${mark ? `<span class="mark ${mark.className}" role="img" aria-label="${mark.label}">${mark.symbol}</span>` : `<span class="tag ${statusTagClass(display.primary)}">${escapeHtml(statusLabel(display.primary))}</span>`}
          <span class="result-badges">
            ${bugCheckBadge(test)}
            ${passedAfterRetry(latest, display.primary) ? '<span class="tag tag-retry">Passed after retry</span>' : ''}
          </span>
        </span>
        <span class="row-launch-actions">
          <span class="launch-note" role="status" aria-live="polite" hidden>
            <span class="launch-note-text"></span>
            <button type="button" class="launch-note-close" data-dismiss-note aria-label="Dismiss message">×</button>
          </span>
          ${launchButton('run-playwright-ui', test, isBrowserTest, 'Playwright runs browser tests only.', 'Run in Playwright')}
        </span>
      </span>
    </summary>
    <div class="metadata">
      ${lines.map((line) => `<p>${line}</p>`).join('')}
    </div>
    ${testDisclosures(test)}
    ${errorLogDetails(test, latest)}
    ${retryAttemptDetails(latest, display.primary)}
  </details>`;
}

function exampleCard(example) {
  return `<details class="test-row">
    <summary>
      <span class="scan"><span class="identifier">${escapeHtml(example.id)}</span>&nbsp;<span class="behavior">${escapeHtml(example.name)}</span></span>
      <span class="tag tag-neutral">Example</span>
    </summary>
    <div class="metadata">
      <p>${field('Catalog role', 'Example. This check does not run.')}</p>
      <p>${field('Category', example.category)}</p>
    </div>
    ${methodologyDetails(example.methodology)}
  </details>`;
}

function behaviorRows(tests, examples, feature, latestResults) {
  const cards = [
    ...tests.map((test) => testCard(test, feature, latestResults)),
    ...examples.map((example) => exampleCard(example)),
  ];
  if (cards.length === 0) {
    return '<p class="none">None declared.</p>';
  }
  return cards.join('');
}

function exampleNote(owner) {
  return owner?.example
    ? '<p class="example-note">These entries show how a title and a test methodology read. They do not run, and they do not protect the application.</p>'
    : '';
}

const latest = await readLatest();
await reconstructMissingFailureLogs(latest.tests ?? {});
const coreAreasHtml = testCatalog.criticalCoreAreas
  .map((area) => {
    const tests = testCatalog.tests.filter(
      (test) => test.category === 'critical-core' && test.owner === area.id,
    );
    const examples = testCatalog.examples.filter(
      (example) => example.category === 'critical-core' && example.owner === area.id,
    );
    return `<section class="core-area">
      <h3>${heading(area.name, area.id)}</h3>
      ${exampleNote(area)}
      ${behaviorRows(tests, examples, null, latest.tests)}
    </section>`;
  })
  .join('');
const coreHtml = `<details class="critical-core">
  <summary>Critical Core</summary>
  ${coreAreasHtml || '<p class="none">None declared.</p>'}
</details>`;

const featureSetsHtml = testCatalog.featureSets
  .map((featureSet) => {
    const features = testCatalog.features.filter(
      (feature) => feature.featureSetId === featureSet.id,
    );
    const featureHtml = features
      .map((feature) => {
        const behavior = testCatalog.tests.filter(
          (test) => test.owner === feature.id && test.category === 'feature-behavior',
        );
        const examples = testCatalog.examples.filter(
          (example) =>
            example.owner === feature.id && example.category === 'feature-behavior',
        );
        return `<section class="feature">
          <h3>${heading(feature.name, feature.id)}</h3>
          ${behaviorRows(behavior, examples, feature, latest.tests)}
        </section>`;
      })
      .join('');
    return `<section class="feature-set">
      <h2>${heading(featureSet.name, featureSet.id)}</h2>
      ${exampleNote(featureSet)}
      ${featureHtml}
    </section>`;
  })
  .join('');

const gate = currentGatePresentation(latest);
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Test catalog: Feature Behavior Tests and Critical Core Tests</title>
  <style>
    :root { color-scheme: dark; }
    body {
      background: #000000;
      color: #ffffff;
      font-family: system-ui, "Segoe UI", sans-serif;
      margin: 0;
      padding: 20px;
      text-align: left;
    }
    .reading {
      background: #000000;
      box-sizing: border-box;
      max-width: 40rem;
      padding: 20px;
    }
    h1, h2, h3, p { margin: 0; }
    h1 {
      color: #ffffff;
      font-size: 36px;
      font-weight: 700;
      line-height: 40px;
      margin-bottom: 10px;
    }
    .notice {
      color: #ffffff;
      font-size: 19px;
      font-weight: 400;
      line-height: 25px;
      margin-bottom: 10px;
    }
    .summary {
      color: #b1b4b6;
      font-size: 16px;
      line-height: 22px;
      margin: 0 0 4px;
    }
    .summary-last { margin-bottom: 30px; }
    .word-passed { color: #6fcf97; }
    .word-failed { color: #e07a7a; }
    h2 {
      color: #ffffff;
      font-size: 24px;
      font-weight: 700;
      line-height: 30px;
      margin-bottom: 10px;
    }
    h3 {
      color: #ffffff;
      font-size: 19px;
      font-weight: 700;
      line-height: 25px;
      margin-bottom: 10px;
    }
    .feature-set + .feature-set { margin-top: 30px; }
    .feature + .feature { margin-top: 20px; }
    .feature, .core-area { margin-left: 20px; }
    .identifier {
      color: #7eb6ff;
      font-size: inherit;
      font-weight: inherit;
      line-height: inherit;
      white-space: nowrap;
    }
    /* Visible catalog test identifier on a test row, such as FBT-E001. Not an HTML id attribute. */
    .test-row .identifier {
      font-size: 19px;
      font-weight: 400;
      line-height: 25px;
    }
    .none, .metadata, .field-label, .example-note {
      color: #b1b4b6;
      font-size: 16px;
      font-weight: 400;
      line-height: 20px;
    }
    .example-note { margin: 0 0 10px; }
    .field-label::after { content: ":"; }
    .none { margin: 0 0 10px 20px; }
    .test-row { border-bottom: 1px solid #5c5c5c; margin-left: 20px; }
    .result-column {
      align-items: flex-end;
      display: flex;
      flex: 0 0 auto;
      flex-direction: column;
      gap: 8px;
      position: relative;
    }
    /* Launch note floats under the button, so it never narrows the test title. */
    .launch-note {
      align-items: flex-start;
      background: #000000;
      border: 1px solid #5c5c5c;
      color: #b1b4b6;
      cursor: default;
      display: flex;
      font-size: 14px;
      gap: 8px;
      line-height: 18px;
      padding: 4px 4px 4px 8px;
      position: absolute;
      right: 0;
      text-align: left;
      top: 100%;
      width: 18rem;
      z-index: 1;
    }
    .launch-note[hidden] { display: none; }
    .launch-note-text { flex: 1 1 auto; }
    .launch-note-close {
      background: none;
      border: 0;
      color: #ffffff;
      cursor: pointer;
      flex: 0 0 auto;
      font: inherit;
      font-size: 18px;
      line-height: 18px;
      padding: 0 6px;
    }
    .launch-note-close:focus-visible {
      background: #ffdd00;
      color: #0b0c0c;
      outline: 3px solid #ffdd00;
    }
    .row-launch-actions {
      align-items: center;
      display: flex;
      gap: 10px;
      justify-content: flex-end;
    }
    .metadata { padding: 0 0 4px 28px; }
    .metadata p { margin: 0; }
    .methodology { margin: 0 0 10px 28px; }
    .methodology > summary {
      color: #b1b4b6;
      font-size: 16px;
      font-weight: 400;
      line-height: 20px;
      padding: 4px 0;
    }
    .methodology > summary::before { margin-top: 4px; }
    .methodology[open] > summary::before { margin-top: 2px; }
    .methodology p {
      color: #ffffff;
      font-size: 16px;
      font-weight: 400;
      line-height: 22px;
      padding: 0 0 8px 28px;
    }
    .retry-error { white-space: pre-wrap; }
    summary {
      align-items: flex-start;
      color: #ffffff;
      cursor: pointer;
      display: flex;
      gap: 8px;
      list-style: none;
      padding: 10px 0;
    }
    summary::-webkit-details-marker { display: none; }
    summary::marker { content: none; }
    summary::before {
      border-bottom: 2px solid #ffffff;
      border-right: 2px solid #ffffff;
      content: "";
      flex: 0 0 auto;
      height: 7px;
      margin-top: 7px;
      transform: rotate(-45deg);
      width: 7px;
    }
    details[open] > summary::before {
      margin-top: 5px;
      transform: rotate(45deg);
    }
    .scan { flex: 1 1 auto; min-width: 0; }
    .tags {
      align-items: center;
      display: flex;
      flex: 0 0 auto;
      gap: 10px;
    }
    .timing {
      color: #b1b4b6;
      font-size: 16px;
      font-variant-numeric: tabular-nums;
      line-height: 22px;
      white-space: nowrap;
    }
    .mark {
      align-items: center;
      border-radius: 999px;
      display: inline-flex;
      flex: 0 0 auto;
      font-size: 18px;
      font-weight: 700;
      height: 28px;
      justify-content: center;
      line-height: 1;
      width: 28px;
    }
    .mark-passed { background: #00703c; color: #ffffff; }
    .mark-failed { background: #d4351c; color: #ffffff; }
    .result-badges {
      align-items: flex-end;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .behavior {
      color: #ffffff;
      font-size: 19px;
      font-weight: 400;
      line-height: 25px;
    }
    .tag {
      flex: 0 0 auto;
      font-size: 16px;
      font-weight: 400;
      line-height: 20px;
      padding: 2px 8px;
    }
    .tag-passed { background: #cfe4dc; color: #083d29; }
    .tag-bug-check { background: #efe4f7; color: #3b1764; }
    .tag-retry { background: #d9e2ec; color: #243b53; }
    .tag-failed { background: #f4d7d7; color: #651b1b; }
    .tag-neutral { background: #f3f3f3; color: #484949; }
    .critical-core { border-top: 1px solid #5c5c5c; margin-top: 30px; }
    .critical-core > summary {
      color: #ffffff;
      font-size: 24px;
      font-weight: 700;
      line-height: 30px;
    }
    .critical-core > summary::before { margin-top: 10px; }
    .critical-core[open] > summary::before { margin-top: 8px; }
    summary:focus-visible {
      background: #ffdd00;
      box-shadow: 0 -2px #ffdd00, 0 4px #ffdd00;
      color: #0b0c0c;
      outline: 3px solid #ffdd00;
    }
    summary:focus-visible::before {
      border-bottom-color: #0b0c0c;
      border-right-color: #0b0c0c;
    }
    summary:focus-visible .behavior,
    summary:focus-visible .identifier,
    summary:focus-visible .tag,
    summary:focus-visible .timing {
      color: #0b0c0c;
    }
    /* Error logs: same gray-on-black documentation look, monospace for machine output. */
    .error-logs .log-body { padding: 0 0 8px 28px; }
    .error-logs .log-body p { padding: 0; }
    .error-logs .log-title {
      color: #ffffff;
      font-size: 16px;
      line-height: 22px;
      margin-bottom: 4px;
    }
    .error-logs .log-meta, .error-logs .log-artifact {
      color: #b1b4b6;
      font-size: 16px;
      line-height: 20px;
    }
    .error-logs .log-label {
      color: #b1b4b6;
      font-size: 16px;
      line-height: 20px;
      margin-top: 10px;
    }
    .log-block {
      border-left: 2px solid #5c5c5c;
      color: #ffffff;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 13px;
      line-height: 18px;
      margin: 4px 0 0;
      max-height: 20rem;
      overflow: auto;
      padding: 4px 0 4px 10px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .log-path {
      color: #b1b4b6;
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 13px;
      word-break: break-all;
    }
    .log-artifact a { color: #7eb6ff; }
    .log-actions {
      align-items: center;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin: 4px 0 12px;
    }
    .log-button {
      background: #000000;
      border: 1px solid #b1b4b6;
      color: #ffffff;
      cursor: pointer;
      font: inherit;
      font-size: 16px;
      line-height: 20px;
      padding: 4px 10px;
    }
    .log-button:hover:not(:disabled) { border-color: #ffffff; }
    .log-button:disabled { border-color: #5c5c5c; color: #5c5c5c; cursor: not-allowed; }
    .log-button:focus-visible, .log-artifact a:focus-visible {
      background: #ffdd00;
      color: #0b0c0c;
      outline: 3px solid #ffdd00;
    }
    .log-status { color: #b1b4b6; font-size: 16px; line-height: 20px; }
    .error-logs .llm-markdown { margin: 0 0 12px; }
  </style>
</head>
<body>
  <main class="reading">
    <h1>Feature-centered test catalog</h1>
    <p class="notice">Opening this page runs no tests.</p>
    ${latestRunSummary(latest)}
    ${releaseGateSummary(latest, gate)}
    ${featureSetsHtml}
    ${coreHtml}
  </main>
  <script>
    // Copy works anywhere; Playwright and trace launch buttons need the local catalog server.
    function setStatus(button, message) {
      const rowActions = button.closest('.row-launch-actions');
      if (rowActions) {
        const note = rowActions.querySelector('.launch-note');
        note.querySelector('.launch-note-text').textContent = message;
        note.hidden = false;
        return;
      }
      button.closest('.log-actions').querySelector('.log-status').textContent = message;
    }

    function dismissLaunchNotes(exceptNote) {
      for (const note of document.querySelectorAll('.launch-note:not([hidden])')) {
        if (note !== exceptNote) note.hidden = true;
      }
    }

    async function copyForLlm(button) {
      const block = button.closest('.log-body').querySelector('.llm-markdown');
      const markdown = block.textContent;
      try {
        await navigator.clipboard.writeText(markdown);
        setStatus(button, 'Copied Markdown for an LLM.');
        return;
      } catch {
        // Some embedded browsers block the async clipboard; fall back to a hidden textarea copy.
      }
      if (copyWithTextarea(markdown)) {
        setStatus(button, 'Copied Markdown for an LLM.');
        return;
      }
      // Last resort: show the Markdown selected, so Cmd+C or Ctrl+C copies it.
      block.hidden = false;
      const range = document.createRange();
      range.selectNodeContents(block);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      setStatus(button, 'This browser blocks clipboard access. The Markdown is shown below and selected; press Cmd+C.');
    }

    function copyWithTextarea(text) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      }
      textarea.remove();
      return copied;
    }

    async function launch(button) {
      if (location.protocol === 'file:') {
        setStatus(button, 'Launching needs the catalog server: run npm run test:view-test-catalog.');
        return;
      }
      button.disabled = true;
      setStatus(button, 'Starting…');
      try {
        const response = await fetch('/api/' + button.dataset.launch, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ testId: button.dataset.testId }),
        });
        setStatus(button, (await response.text()).trim());
      } catch {
        setStatus(button, 'The catalog server is not reachable. Is it still running?');
      } finally {
        button.disabled = false;
      }
    }

    document.addEventListener('click', (event) => {
      const insideNote = event.target.closest('.launch-note');
      const button = event.target.closest('button');
      // A click outside the open note closes it. Clicking the button re-opens it right after.
      dismissLaunchNotes(insideNote);
      if (insideNote) {
        // The note sits inside a row header, so keep its clicks from toggling the row.
        event.preventDefault();
        event.stopPropagation();
        if (button?.hasAttribute('data-dismiss-note')) insideNote.hidden = true;
        return;
      }
      if (!button || button.disabled) return;
      if (button.hasAttribute('data-copy-llm')) copyForLlm(button);
      else if (button.dataset.launch) {
        event.preventDefault();
        event.stopPropagation();
        launch(button);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') dismissLaunchNotes(null);
    });
  </script>
</body>
</html>`;

function catalogCliFlags(argv) {
  const knownFlags = new Set(['--no-open', '--no-serve']);
  const unknown = argv.filter((arg) => !knownFlags.has(arg));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown option ${unknown.join(' ')}. Supported options: --no-open, --no-serve.`,
    );
  }
  return {
    serve: !argv.includes('--no-serve'),
    openBrowser: !argv.includes('--no-open'),
  };
}

function preferredCatalogPort() {
  const raw = process.env.TNC_CATALOG_PORT;
  if (raw === undefined || raw.trim() === '') {
    return defaultCatalogPort;
  }
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `TNC_CATALOG_PORT must be an integer from 1 to 65535. Received "${raw}".`,
    );
  }
  const port = Number(trimmed);
  if (port < 1 || port > 65535) {
    throw new Error(
      `TNC_CATALOG_PORT must be an integer from 1 to 65535. Received "${raw}".`,
    );
  }
  return port;
}

function contentTypeFor(filePath) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return types[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function isInsideDirectory(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  if (relative === '' || path.isAbsolute(relative)) {
    return relative === '';
  }
  return relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

function sendText(response, method, status, message, extraHeaders = {}) {
  const body = Buffer.from(message);
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  response.end(method === 'HEAD' ? undefined : body);
}

function decodedRequestPath(requestUrl) {
  const end = requestUrl.search(/[?#]/);
  const pathname = end === -1 ? requestUrl : requestUrl.slice(0, end);
  try {
    return { pathname: decodeURIComponent(pathname) };
  } catch {
    return { status: 400 };
  }
}

async function locateCatalogFile(requestUrl) {
  const decoded = decodedRequestPath(requestUrl);
  if (decoded.status) {
    return { status: decoded.status };
  }
  if (decoded.pathname.includes('\0')) {
    return { status: 400 };
  }
  if (decoded.pathname.split(/[/\\]/).some((segment) => segment === '..')) {
    return { status: 403 };
  }

  let pathname;
  try {
    pathname = new URL(requestUrl, `http://${catalogHost}`).pathname;
  } catch {
    return { status: 400 };
  }
  if (pathname.includes('\0')) {
    return { status: 400 };
  }

  const relativePath = pathname === '/' ? 'catalog.html' : pathname.replace(/^\/+/, '');
  if (relativePath === '' || relativePath.endsWith('/')) {
    return { status: 404 };
  }

  const rootPath = await realpath(resultDirectory);
  const candidate = path.resolve(rootPath, relativePath);
  if (!isInsideDirectory(rootPath, candidate)) {
    return { status: 403 };
  }

  let filePath;
  try {
    filePath = await realpath(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { status: 404 };
    }
    throw error;
  }
  if (!isInsideDirectory(rootPath, filePath)) {
    return { status: 403 };
  }

  const info = await stat(filePath);
  if (!info.isFile()) {
    return { status: 404 };
  }
  return { status: 200, filePath, size: info.size };
}

// ---------------------------------------------------------------------------
// Local launch endpoints: open a stored trace or replay a test in Playwright UI.
// Only two fixed commands exist. The request supplies a catalog test id, never a command or path.
// ---------------------------------------------------------------------------

const launchActions = new Set(['open-trace', 'run-playwright-ui']);
const maxLaunchBodyBytes = 1024;
let servingPort = null;

/** Rejects cross-site and DNS-rebinding requests: Host and Origin must be this loopback server. */
function isSameOriginLocalRequest(request) {
  const expectedHost = `${catalogHost}:${servingPort}`;
  const localHosts = new Set([expectedHost, `localhost:${servingPort}`]);
  if (!localHosts.has(request.headers.host ?? '')) return false;
  const origin = request.headers.origin;
  return origin === undefined || localHosts.has(origin.replace(/^http:\/\//, ''));
}

function readSmallBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > maxLaunchBodyBytes) {
        reject(new Error('Request body too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

/** The stored trace for a test, only if it is a real trace.zip inside .test-results/. */
async function validatedTracePath(testId) {
  const tracePath = effectiveFailureLog(latest.tests?.[testId])?.tracePath;
  if (typeof tracePath !== 'string' || path.basename(tracePath) !== 'trace.zip') return null;
  try {
    const rootPath = await realpath(resultDirectory);
    const resolved = await realpath(path.resolve(root, tracePath));
    if (!isInsideDirectory(rootPath, resolved) || !(await stat(resolved)).isFile()) return null;
    return resolved;
  } catch {
    return null;
  }
}

/** Starts a fixed command detached, so the catalog server stays responsive. Output goes to a log file. */
async function spawnDetached(command, args, logName) {
  const logDirectory = path.join(resultDirectory, 'catalog-launch-logs');
  await mkdir(logDirectory, { recursive: true });
  const logPath = path.join(logDirectory, logName);
  const logFile = openSync(logPath, 'w');
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFile, logFile],
  });
  child.once('error', (error) => console.error(`Could not start ${command}: ${error.message}`));
  child.unref();
  return path.relative(root, logPath);
}

async function handleLaunchRequest(request, response, action) {
  if (!isSameOriginLocalRequest(request)) {
    sendText(response, 'POST', 403, 'Forbidden: launch requests must come from this catalog page.\n');
    return;
  }
  if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
    sendText(response, 'POST', 415, 'Expected application/json.\n');
    return;
  }
  let testId;
  try {
    testId = JSON.parse(await readSmallBody(request))?.testId;
  } catch {
    sendText(response, 'POST', 400, 'Bad request.\n');
    return;
  }
  const test = testCatalog.tests.find((candidate) => candidate.id === testId);
  if (typeof testId !== 'string' || !test) {
    sendText(response, 'POST', 404, 'Unknown catalog test id.\n');
    return;
  }

  if (action === 'open-trace') {
    const tracePath = await validatedTracePath(test.id);
    if (!tracePath) {
      sendText(response, 'POST', 404, `No stored trace for ${test.id}.\n`);
      return;
    }
    const log = await spawnDetached(
      'npx',
      ['--no-install', 'playwright', 'show-trace', tracePath],
      `open-trace-${test.id}.log`,
    );
    console.log(`Opening trace for ${test.id}: ${path.relative(root, tracePath)}`);
    sendText(response, 'POST', 202, `Opening the trace viewer for ${test.id}. Output: ${log}\n`);
    return;
  }

  if (test.environment !== 'browser') {
    sendText(response, 'POST', 400, `${test.id} is not a browser test; UI mode does not apply.\n`);
    return;
  }
  const log = await spawnDetached(
    'npm',
    ['run', 'test:id', '--', test.id, '--ui', '--autorun'],
    `run-playwright-ui-${test.id}.log`,
  );
  console.log(`Running ${test.id} in Playwright UI mode.`);
  sendText(
    response,
    'POST',
    202,
    `Opening Playwright UI for ${test.id} and running it. The window appears after the page server starts. Output: ${log}\n`,
  );
}

async function serveCatalogRequest(request, response) {
  const method = request.method ?? 'GET';
  const launchMatch = /^\/api\/([a-z-]+)$/.exec((request.url ?? '').split('?')[0]);
  if (launchMatch && launchActions.has(launchMatch[1])) {
    if (method !== 'POST') {
      sendText(response, method, 405, 'Method not allowed\n', { Allow: 'POST' });
      return;
    }
    await handleLaunchRequest(request, response, launchMatch[1]);
    return;
  }
  if (method !== 'GET' && method !== 'HEAD') {
    sendText(response, method, 405, 'Method not allowed\n', { Allow: 'GET, HEAD' });
    return;
  }

  const located = await locateCatalogFile(request.url ?? '/');
  if (located.status !== 200) {
    const messages = {
      400: 'Bad request\n',
      403: 'Forbidden\n',
      404: 'Not found\n',
    };
    sendText(response, method, located.status, messages[located.status] ?? 'Error\n');
    return;
  }

  const headers = {
    'Content-Type': contentTypeFor(located.filePath),
    'Content-Length': located.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
  if (method === 'HEAD') {
    response.writeHead(200, headers);
    response.end();
    return;
  }

  const body = await readFile(located.filePath);
  headers['Content-Length'] = body.length;
  response.writeHead(200, headers);
  response.end(body);
}

function handleCatalogRequest(request, response) {
  serveCatalogRequest(request, response).catch((error) => {
    console.error(error);
    if (response.headersSent) {
      response.destroy();
      return;
    }
    sendText(response, request.method ?? 'GET', 500, 'Server error\n');
  });
}

function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = createServer(handleCatalogRequest);
    const onError = (error) => {
      server.close(() => {});
      reject(error);
    };
    server.once('error', onError);
    server.listen(port, catalogHost, () => {
      server.off('error', onError);
      resolve(server);
    });
  });
}

async function listenOnNextFreePort(startPort) {
  const lastPort = Math.min(startPort + maxCatalogPortAttempts - 1, 65535);
  for (let port = startPort; port <= lastPort; port += 1) {
    try {
      const server = await listenOn(port);
      return { server, port };
    } catch (error) {
      if (error?.code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }
  throw new Error(`No free port on ${catalogHost} from ${startPort} through ${lastPort}.`);
}

function openCatalog(url) {
  if (process.platform !== 'darwin') {
    return;
  }
  const child = spawn('open', [url], { stdio: 'ignore' });
  child.once('error', () => {
    console.error(`Could not open ${url} in the browser.`);
  });
  child.unref();
}

function keepServingUntilStopped(server) {
  let stopping = false;
  const stop = () => {
    if (stopping) {
      process.exit(0);
    }
    stopping = true;
    const forceExit = setTimeout(() => process.exit(0), 1000);
    forceExit.unref();
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    server.close(() => {
      clearTimeout(forceExit);
      process.exit(0);
    });
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

let flags;
try {
  flags = catalogCliFlags(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

await mkdir(resultDirectory, { recursive: true });
const outputFile = path.join(resultDirectory, 'catalog.html');
await writeFile(outputFile, html);

if (!flags.serve) {
  console.log(`Static test catalog: ${pathToFileURL(outputFile).href}`);
} else {
  try {
    const preferredPort = preferredCatalogPort();
    const { server, port } = await listenOnNextFreePort(preferredPort);
    servingPort = port;
    const url = `http://${catalogHost}:${port}/`;
    const busyNote = port === preferredPort ? '' : `${preferredPort} was busy; `;
    console.log(`${url} (${busyNote}Ctrl+C stops the server)`);
    keepServingUntilStopped(server);
    if (flags.openBrowser) {
      openCatalog(url);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
