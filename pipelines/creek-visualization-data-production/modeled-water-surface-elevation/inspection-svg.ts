import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Tiny dependency-free line-chart writer for inspection SVGs.
 * Each chart is one panel; several panels stack vertically in one file.
 */

export interface ChartSeries {
  label: string;
  points: { x: number; y: number | null }[];
  color: string;
  strokeWidth?: number;
  dashed?: boolean;
}

export interface ChartPanel {
  title: string;
  xLabel: string;
  yLabel: string;
  series: ChartSeries[];
  /** Optional x tick formatter, e.g. dates. */
  formatX?: (value: number) => string;
}

const PANEL_WIDTH = 900;
const PANEL_HEIGHT = 340;
const MARGIN = { top: 40, right: 24, bottom: 52, left: 78 };

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const rawStep = (max - min) / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= rawStep) ?? rawStep;
  const ticks: number[] = [];
  for (let tick = Math.ceil(min / step) * step; tick <= max + step * 1e-9; tick += step) ticks.push(Number(tick.toFixed(10)));
  return ticks;
}

function formatTick(value: number): string {
  return Math.abs(value) >= 1000 || Number.isInteger(value) ? String(Math.round(value * 1000) / 1000) : value.toPrecision(3);
}

function renderPanel(panel: ChartPanel, offsetY: number): string {
  const allPoints = panel.series.flatMap((series) => series.points.filter((point) => point.y !== null)) as {
    x: number;
    y: number;
  }[];
  if (allPoints.length === 0) return '';
  const xMin = Math.min(...allPoints.map((point) => point.x));
  let xMax = Math.max(...allPoints.map((point) => point.x));
  let yMin = Math.min(...allPoints.map((point) => point.y));
  let yMax = Math.max(...allPoints.map((point) => point.y));
  if (xMin === xMax) xMax = xMin + 1;
  if (yMin === yMax) yMax = yMin + 1;
  const yPad = (yMax - yMin) * 0.05;
  yMin -= yPad;
  yMax += yPad;
  const plotWidth = PANEL_WIDTH - MARGIN.left - MARGIN.right;
  const plotHeight = PANEL_HEIGHT - MARGIN.top - MARGIN.bottom;
  const sx = (x: number): number => MARGIN.left + ((x - xMin) / (xMax - xMin)) * plotWidth;
  const sy = (y: number): number => offsetY + MARGIN.top + (1 - (y - yMin) / (yMax - yMin)) * plotHeight;
  const formatX = panel.formatX ?? formatTick;

  const parts: string[] = [];
  parts.push(
    `<text x="${MARGIN.left}" y="${offsetY + 24}" font-size="15" font-weight="600">${escapeXml(panel.title)}</text>`,
  );
  for (const tick of niceTicks(yMin, yMax, 6)) {
    parts.push(
      `<line x1="${MARGIN.left}" x2="${MARGIN.left + plotWidth}" y1="${sy(tick)}" y2="${sy(tick)}" stroke="#e5e7eb"/>`,
      `<text x="${MARGIN.left - 8}" y="${sy(tick) + 4}" font-size="11" text-anchor="end">${formatTick(tick)}</text>`,
    );
  }
  for (const tick of niceTicks(xMin, xMax, 8)) {
    parts.push(
      `<line x1="${sx(tick)}" x2="${sx(tick)}" y1="${offsetY + MARGIN.top}" y2="${offsetY + MARGIN.top + plotHeight}" stroke="#f3f4f6"/>`,
      `<text x="${sx(tick)}" y="${offsetY + MARGIN.top + plotHeight + 16}" font-size="11" text-anchor="middle">${escapeXml(formatX(tick))}</text>`,
    );
  }
  parts.push(
    `<rect x="${MARGIN.left}" y="${offsetY + MARGIN.top}" width="${plotWidth}" height="${plotHeight}" fill="none" stroke="#9ca3af"/>`,
    `<text x="${MARGIN.left + plotWidth / 2}" y="${offsetY + PANEL_HEIGHT - 10}" font-size="12" text-anchor="middle">${escapeXml(panel.xLabel)}</text>`,
    `<text transform="translate(18 ${offsetY + MARGIN.top + plotHeight / 2}) rotate(-90)" font-size="12" text-anchor="middle">${escapeXml(panel.yLabel)}</text>`,
  );
  panel.series.forEach((series, seriesIndex) => {
    let pathData = '';
    let penDown = false;
    for (const point of series.points) {
      if (point.y === null) {
        penDown = false;
        continue;
      }
      pathData += `${penDown ? 'L' : 'M'}${sx(point.x).toFixed(1)},${sy(point.y).toFixed(1)}`;
      penDown = true;
    }
    parts.push(
      `<path d="${pathData}" fill="none" stroke="${series.color}" stroke-width="${series.strokeWidth ?? 1.5}"${series.dashed ? ' stroke-dasharray="6 4"' : ''}/>`,
    );
    const legendY = offsetY + MARGIN.top + 14 + seriesIndex * 16;
    const legendX = MARGIN.left + plotWidth - 230;
    parts.push(
      `<line x1="${legendX}" x2="${legendX + 22}" y1="${legendY - 4}" y2="${legendY - 4}" stroke="${series.color}" stroke-width="${series.strokeWidth ?? 1.5}"${series.dashed ? ' stroke-dasharray="6 4"' : ''}/>`,
      `<text x="${legendX + 28}" y="${legendY}" font-size="11">${escapeXml(series.label)}</text>`,
    );
  });
  return parts.join('\n');
}

export async function writeInspectionSvg(filePath: string, panels: ChartPanel[]): Promise<void> {
  const height = PANEL_HEIGHT * panels.length;
  const body = panels.map((panel, index) => renderPanel(panel, index * PANEL_HEIGHT)).join('\n');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PANEL_WIDTH}" height="${height}" viewBox="0 0 ${PANEL_WIDTH} ${height}" font-family="system-ui, sans-serif">\n` +
    `<rect width="100%" height="100%" fill="white"/>\n${body}\n</svg>\n`;
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, svg);
}

export function formatUtcDate(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(5, 10);
}
