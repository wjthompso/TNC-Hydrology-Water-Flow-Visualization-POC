import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** CPU use is sampled for this long. It is the only wait the reading adds to a run. */
const CPU_SAMPLE_MS = 1000;
const BUSIEST_PROCESS_COUNT = 3;

export interface BusyProcess {
  name: string;
  pid: number;
  cpuPercent: number;
}

/**
 * How busy the machine already was when a test command started, before it launched any
 * browser. Diagnostic only: it never passes or fails a test. Comparing it across runs shows
 * whether a slow run happened on a busier machine.
 */
export interface MachineLoadSnapshot {
  capturedAt: string;
  logicalCores: number;
  /** Share of all cores in use over the one-second sample, 0 to 100. */
  cpuBusyPercent: number;
  /** macOS only. Null where the graphics chip's utilization cannot be read. */
  gpuBusyPercent: number | null;
  /** Busiest other processes, most CPU first. Empty off macOS and Linux, or when `ps` fails. */
  busiestProcesses: BusyProcess[];
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const { times } of os.cpus()) {
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

/** Real CPU use over a short window, not the load average, which still holds the previous run. */
async function sampleCpuBusyPercent(): Promise<number> {
  const before = cpuTimes();
  await new Promise((resolve) => setTimeout(resolve, CPU_SAMPLE_MS));
  const after = cpuTimes();
  const total = after.total - before.total;
  if (total <= 0) return 0;
  return ((total - (after.idle - before.idle)) / total) * 100;
}

/** The macOS graphics accelerator's own utilization counter. It needs no administrator rights. */
async function readGpuBusyPercent(): Promise<number | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
    const match = /"Device Utilization %"=(\d+)/.exec(stdout);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** `ps` reports a short recent average per process, which is what shows a process that has been busy lately. */
async function readBusiestProcesses(): Promise<BusyProcess[]> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return [];
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,pcpu=,comm=']);
    const processes: BusyProcess[] = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+([\d.]+)\s+(.+)$/.exec(line);
      if (!match) continue;
      const name = path.basename(match[3].trim());
      const pid = Number(match[1]);
      // The runner and the `ps` call that reads the list are not "other" background work.
      if (pid === process.pid || name === 'ps') continue;
      processes.push({ name, pid, cpuPercent: Math.round(Number(match[2])) });
    }
    return processes.sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, BUSIEST_PROCESS_COUNT);
  } catch {
    return [];
  }
}

/** Any part that cannot be read comes back empty or null. This never throws and never fails a run. */
export async function captureMachineLoad(): Promise<MachineLoadSnapshot> {
  const [cpuBusyPercent, gpuBusyPercent, busiestProcesses] = await Promise.all([
    sampleCpuBusyPercent(),
    readGpuBusyPercent(),
    readBusiestProcesses(),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    logicalCores: os.cpus().length,
    cpuBusyPercent: Math.round(cpuBusyPercent),
    gpuBusyPercent,
    busiestProcesses,
  };
}

/** Console label for a process name already stored as a basename. */
function displayProcessName(name: string): string {
  if (name === 'com.apple.WebKit.WebContent') return 'WebKit content';
  if (name === 'com.apple.WebKit.GPU') return 'WebKit GPU';
  const cursorHelper = /^Cursor Helper(?: \(([^)]+)\))?$/.exec(name);
  if (cursorHelper) return cursorHelper[1] ? `Cursor Helper (${cursorHelper[1]})` : 'Cursor Helper';
  return name;
}

/** The short console block printed at the start of a run. */
export function machineLoadLine(snapshot: MachineLoadSnapshot): string {
  const cpuPercent = `${snapshot.cpuBusyPercent}%`;
  const gpuPercent = snapshot.gpuBusyPercent === null ? null : `${snapshot.gpuBusyPercent}%`;
  const metricWidth = Math.max(cpuPercent.length, gpuPercent?.length ?? 0, 5);
  const cores = snapshot.logicalCores === 1 ? 'core' : 'cores';
  const lines = [
    'Machine load before this run',
    `  CPU ${cpuPercent.padStart(metricWidth)} busy, across ${snapshot.logicalCores} ${cores}`,
  ];
  if (gpuPercent !== null) lines.push(`  GPU ${gpuPercent.padStart(metricWidth)} busy`);
  if (snapshot.busiestProcesses.length > 0) {
    const rows = snapshot.busiestProcesses.map((process) => ({
      name: displayProcessName(process.name),
      percent: `${process.cpuPercent}%`,
      pid: String(process.pid),
    }));
    const nameWidth = Math.max(...rows.map((row) => row.name.length));
    const percentWidth = Math.max(...rows.map((row) => row.percent.length));
    const pidWidth = Math.max(...rows.map((row) => row.pid.length));
    lines.push(
      '  Already running',
      ...rows.map(
        (row) =>
          `    ${row.name.padEnd(nameWidth)}    ${row.percent.padStart(percentWidth)}   pid ${row.pid.padStart(pidWidth)}`,
      ),
    );
  }
  return lines.join('\n');
}
