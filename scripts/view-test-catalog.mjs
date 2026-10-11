import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { catalogResultState } from '../tests/support/reporting/result-state.ts';

const catalogHost = '127.0.0.1';
const defaultCatalogPort = 4174;
const maxCatalogPortAttempts = 100;

const root = process.cwd();
const resultDirectory = path.join(root, '.test-results');
const catalog = JSON.parse(
  await readFile(path.join(root, 'tests/support/catalog/catalog.json'), 'utf8'),
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
  'flaky',
]);

export function recordedExecutionState(latest) {
  const state = latest?.state;
  return recordedExecutionStates.has(state) ? state : null;
}

export function humanFacingCatalogResult(test, feature, latest) {
  const recorded = recordedExecutionState(latest);
  const lifecycle = feature?.lifecycle ?? 'not-applicable';
  const primary = catalogResultState(recorded, lifecycle, test.enforcement);
  return {
    lifecycle,
    primary,
    lastExecution: recorded && recorded !== primary ? recorded : null,
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
    flaky: 'Flaky',
    disabled: 'Disabled',
    deprecated: 'Deprecated',
    retired: 'Retired',
    unexecuted: 'Unexecuted',
  };
  return labels[primary] ?? primary;
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

function methodologyDetails(methodology) {
  return `<details class="methodology">
      <summary>Test methodology</summary>
      <p>${escapeHtml(methodology)}</p>
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
  if (latest) {
    lines.push(field('Duration', formatDuration(latest.durationMs)));
    lines.push(field('Recorded', latest.timestamp));
  }
  if (display.lastExecution) {
    lines.push(`Last execution: ${escapeHtml(display.lastExecution)}`);
  }
  return `<details class="test-row">
    <summary>
      <span class="scan"><span class="identifier">${escapeHtml(test.id)}</span>&nbsp;<span class="behavior">${escapeHtml(test.name)}</span></span>
      <span class="tag ${statusTagClass(display.primary)}">${escapeHtml(statusLabel(display.primary))}</span>
    </summary>
    <div class="metadata">
      ${lines.map((line) => `<p>${line}</p>`).join('')}
    </div>
    ${methodologyDetails(test.methodology)}
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
const coreAreasHtml = catalog.criticalCoreAreas
  .map((area) => {
    const tests = catalog.tests.filter(
      (test) => test.category === 'critical-core' && test.owner === area.id,
    );
    const examples = catalog.examples.filter(
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

const featureSetsHtml = catalog.featureSets
  .map((featureSet) => {
    const features = catalog.features.filter(
      (feature) => feature.featureSetId === featureSet.id,
    );
    const featureHtml = features
      .map((feature) => {
        const behavior = catalog.tests.filter(
          (test) => test.owner === feature.id && test.category === 'feature-behavior',
        );
        const examples = catalog.examples.filter(
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

const gateStatus = latest.gateStatus ?? 'unexecuted';
const gateStatusClass =
  gateStatus === 'passed' ? 'word-passed' : gateStatus === 'failed' ? 'word-failed' : '';
const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Feature-centered test catalog</title>
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
    .gate {
      color: #b1b4b6;
      font-size: 16px;
      line-height: 20px;
      margin-bottom: 30px;
    }
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
    summary:focus-visible .tag {
      color: #0b0c0c;
    }
  </style>
</head>
<body>
  <main class="reading">
    <h1>Feature-centered test catalog</h1>
    <p class="notice">Opening this page runs no tests.</p>
    <p class="gate">Latest release gate: <span class="${gateStatusClass}">${escapeHtml(statusLabel(gateStatus))}</span> · Results generated: ${escapeHtml(latest.generatedAt ?? 'never')}</p>
    ${featureSetsHtml}
    ${coreHtml}
  </main>
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

async function serveCatalogRequest(request, response) {
  const method = request.method ?? 'GET';
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
