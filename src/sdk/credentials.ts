/**
 * Module-level configuration for the `comfy.*` namespace.
 *
 * Deliberately module-level rather than per-instance: the namespace mirrors
 * the ergonomics an integrator porting from a comparable hosted-inference
 * client already has in their fingers, and a familiar one-line configuration
 * call is most of what makes that port feel small. The class client
 * (`new Comfy({ apiKey })`) is unchanged and still resolves per instance —
 * the two surfaces coexist, and the asymmetry with the Python SDK (which
 * resolves per client instance only) is intentional, not a parity gap.
 *
 * ```ts
 * import { comfy } from "@comfyorg/sdk";
 *
 * comfy.config({ credentials: "comfyui-..." });
 * ```
 *
 * The configured value is held in a module-private binding that is not
 * reachable from any exported object, so `JSON.stringify(comfy)` and
 * `console.log(comfy)` cannot print it. `credentials.test.ts` asserts that.
 */

/** Environment variable read when {@link config} set no credentials. */
export const CREDENTIALS_ENV_VAR = "COMFY_API_KEY";

export interface ComfyConfig {
  /**
   * Credential sent as the bearer token for `comfy.*` calls — the same key
   * `new Comfy({ apiKey })` takes. Pass `undefined` to clear a previously
   * configured value (which re-exposes the environment fallback).
   */
  credentials?: string;
}

/**
 * Not a property of any exported object, on purpose — see the module note.
 * `undefined` means "nothing configured", which is distinct from
 * "configured empty" (rejected outright by {@link config}).
 */
let configuredCredentials: string | undefined;

/**
 * Set module-level configuration for subsequent `comfy.*` calls.
 *
 * Only the keys present on `options` are touched, so a later
 * `config({})` is a no-op rather than a reset. Passing an explicit
 * `credentials: undefined` clears the configured credential.
 *
 * @throws {TypeError} if `credentials` is neither a non-blank string nor
 * `undefined`. The message names the field and the offending *type* only —
 * never the value — so a mistyped secret cannot land in a log or a stack.
 */
export function config(options: ComfyConfig): void {
  if (!("credentials" in options)) return;
  const value = options.credentials;
  if (value === undefined) {
    configuredCredentials = undefined;
    return;
  }
  if (typeof value !== "string") {
    throw new TypeError(
      `config({ credentials }) must be a string or undefined, got ${typeof value}`,
    );
  }
  // Blank is a mistake, not a clear: silently ignoring it would fall through
  // to the environment and quietly break the documented precedence.
  if (value.trim() === "") {
    throw new TypeError("config({ credentials }) must not be empty; pass undefined to clear it");
  }
  configuredCredentials = value;
}

/**
 * The credential in force: whatever {@link config} set, else
 * `COMFY_API_KEY` from the environment, else `undefined`.
 *
 * Read at call time rather than at module load so a process can reconfigure
 * mid-run and so a test can stub the environment. A runtime with no
 * `process` (a browser) simply never sees the fallback; a blank or
 * whitespace-only variable counts as unset, so `COMFY_API_KEY=` in a shell
 * profile is not an error.
 */
export function resolveCredentials(): string | undefined {
  if (configuredCredentials !== undefined) return configuredCredentials;
  const fromEnv = globalThis.process?.env?.[CREDENTIALS_ENV_VAR]?.trim();
  return fromEnv ? fromEnv : undefined;
}
