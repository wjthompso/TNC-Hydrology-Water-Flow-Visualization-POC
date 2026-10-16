import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishCreekVisualizationData } from '../../../../../pipelines/creek-visualization-data-production/publish.ts';

const TEST_NAME =
  'Rebuilding the published creek visualization data from retained source snapshots reproduces the shipped files byte for byte.';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const SHIPPED_DIRECTORY = 'apps/creek-visualization-browser/public/published-creek-visualization-data';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Shipped files as committed at HEAD, so an uncommitted republish cannot make the test agree with itself. */
function committedShippedFiles(): Map<string, string> {
  const listing = execFileSync('git', ['ls-files', '-z', '--', SHIPPED_DIRECTORY], { cwd: repositoryRoot });
  const files = new Map<string, string>();
  for (const repositoryPath of listing.toString('utf8').split('\0').filter(Boolean)) {
    const bytes = execFileSync('git', ['show', `HEAD:${repositoryPath}`], { cwd: repositoryRoot, maxBuffer: 256 * 1024 * 1024 });
    files.set(path.posix.relative(SHIPPED_DIRECTORY, repositoryPath), sha256(bytes));
  }
  return files;
}

async function rebuiltFiles(directory: string): Promise<Map<string, string>> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = new Map<string, string>();
  for (const entry of entries.filter((item) => item.isFile())) {
    const absolutePath = path.join(entry.parentPath, entry.name);
    files.set(path.relative(directory, absolutePath).split(path.sep).join('/'), sha256(await readFile(absolutePath)));
  }
  return files;
}

let temporaryDirectory: string | null = null;

afterEach(async () => {
  vi.restoreAllMocks();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

describe('FST-003', () => {
  it(TEST_NAME, async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'fst-003-'));
    const outputDirectory = path.join(temporaryDirectory, 'published-creek-visualization-data');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await publishCreekVisualizationData({
      outputDirectory,
      assignmentOutputPath: path.join(temporaryDirectory, 'monitoring-station-assignment.json'),
    });

    const committed = committedShippedFiles();
    expect(committed.size).toBeGreaterThan(0);
    const rebuilt = await rebuiltFiles(outputDirectory);
    expect([...rebuilt.keys()].sort()).toEqual([...committed.keys()].sort());
    for (const [relativePath, committedHash] of committed) {
      expect(rebuilt.get(relativePath), `${SHIPPED_DIRECTORY}/${relativePath}`).toBe(committedHash);
    }
  });
});
