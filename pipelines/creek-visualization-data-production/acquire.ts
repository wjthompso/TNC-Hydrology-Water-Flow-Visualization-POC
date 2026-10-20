import process from 'node:process';
import { retainSourceInputs } from './source-input-retention.ts';

try {
  await retainSourceInputs();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
