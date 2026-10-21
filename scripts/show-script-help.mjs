import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(
  await readFile(path.join(repositoryRoot, 'package.json'), 'utf8'),
);
const { usage, testSelectors, testViewingFlags, modeledWseFlags, commands } =
  packageJson.scriptDescriptions;
const terminalWidth = Math.max(40, process.stdout.columns ?? 100);
const colorsEnabled = process.stdout.isTTY && !('NO_COLOR' in process.env);
const bold = (text) => colorsEnabled ? `\u001B[1m${text}\u001B[22m` : text;
const commandStyle = (text) =>
  colorsEnabled ? `\u001B[1;36m${text}\u001B[0m` : text;

function wrap(text, indentation = '  ') {
  const availableWidth = Math.max(20, terminalWidth - indentation.length);
  const words = text.match(/`[^`]+`|\S+/g) ?? [];
  const lines = [];
  let line = '';

  for (const word of words) {
    if (line && line.length + word.length + 1 > availableWidth) {
      lines.push(`${indentation}${line}`);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }

  if (line) lines.push(`${indentation}${line}`);
  return lines;
}

const output = [bold('Creek Water Visualization commands'), ''];

for (const [heading, description] of [
  ['Usage', usage],
  ['Test selectors', testSelectors],
  ['Test viewing flags', testViewingFlags],
  ['Modeled water-surface elevation flags', modeledWseFlags],
]) {
  output.push(bold(heading), ...wrap(description), '');
}

output.push(bold('Commands'), '');

for (const [command, description] of Object.entries(commands)) {
  output.push(commandStyle(`npm run ${command}`), ...wrap(description, '    '), '');
}

process.stdout.write(`${output.join('\n')}\n`);
