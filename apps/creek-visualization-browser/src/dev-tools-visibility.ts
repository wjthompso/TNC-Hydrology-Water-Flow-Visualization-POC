/**
 * Whether the Dev tools button and the `?devtools` address-bar hatch are available.
 *
 * An unset value follows the Vite mode: on for the development server, off for
 * a production build. `true`, `1`, and `yes` force them on. `false`, `0`, and
 * `no` force them off, including on the development server. Any other value
 * warns and follows the Vite mode, so a typo does not take the page down.
 */

export interface DevToolsVisibilityEnvironment {
  readonly DEV?: boolean;
  readonly VITE_SHOW_DEV_TOOLS?: string;
}

const TRUTHY_FLAGS = new Set(['true', '1', 'yes']);
const FALSY_FLAGS = new Set(['false', '0', 'no']);

export function resolveShowDevTools(environment: DevToolsVisibilityEnvironment): boolean {
  const requested = environment.VITE_SHOW_DEV_TOOLS?.trim().toLowerCase() ?? '';
  if (requested === '') return Boolean(environment.DEV);
  if (TRUTHY_FLAGS.has(requested)) return true;
  if (FALSY_FLAGS.has(requested)) return false;
  console.warn(
    `VITE_SHOW_DEV_TOOLS must be "true" or "false"; received "${environment.VITE_SHOW_DEV_TOOLS}". Dev tools follow the development-server default instead.`,
  );
  return Boolean(environment.DEV);
}
