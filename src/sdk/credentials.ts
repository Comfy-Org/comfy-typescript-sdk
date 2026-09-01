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
 * `baseUrl` lives here too, so a process points the namespace at a staging
 * deployment (or a test stub) the same way it supplies a credential.
 *
 * The configured value is held in a module-private binding that is not
 * reachable from any exported object, so `JSON.stringify(comfy)` and
 * `console.log(comfy)` cannot print it. `credentials.test.ts` asserts that.
 */

/** Environment variable read when {@link config} set no credentials. */
export const CREDENTIALS_ENV_VAR = "COMFY_API_KEY";

/**
 * Where `comfy.models.run` sends its calls by default — the Comfy API host
 * that fronts the model router.
 *
 * Deliberately NOT the same value the class client defaults to. `new Comfy()`
 * talks the Comfy API v2 job/asset surface (`/api/v2/...`), which a
 * self-hosted proxy or a serverless deployment also serves; the model router
 * is a hosted, partner-model gateway on its own host and its own
 * `/v2/models/...` routes. Pointing one at the other would 404, so they are
 * two settings rather than one.
 */
export const COMFY_ROUTER_BASE_URL = "https://api.comfy.org";

/** Environment variable read when {@link config} set no `baseUrl`. */
export const ROUTER_BASE_URL_ENV_VAR = "COMFY_ROUTER_BASE_URL";

export interface ComfyConfig {
  /**
   * Credential sent as the bearer token for `comfy.*` calls — the same key
   * `new Comfy({ apiKey })` takes. Pass `undefined` to clear a previously
   * configured value (which re-exposes the environment fallback).
   */
  credentials?: string;
  /**
   * Base URL for `comfy.*` calls, without a trailing path — normally left
   * alone, and set when pointing the namespace at a staging deployment or a
   * local stub. Pass `undefined` to clear a previously configured value
   * (which re-exposes the environment fallback and then
   * {@link COMFY_ROUTER_BASE_URL}).
   *
   * This is the router host, NOT the class client's `COMFY_BASE_URL` — see
   * {@link COMFY_ROUTER_BASE_URL}.
   */
  baseUrl?: string;
}

/**
 * Not a property of any exported object, on purpose — see the module note.
 * `undefined` means "nothing configured", which is distinct from
 * "configured empty" (rejected outright by {@link config}).
 */
let configuredCredentials: string | undefined;

/** Same reasoning as {@link configuredCredentials}, minus the secrecy: it is
 * module-private so `config` stays the one way to set it. */
let configuredBaseUrl: string | undefined;

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
 * @throws {TypeError} if `baseUrl` is neither an http(s) URL with no query or
 * fragment nor `undefined`. That message DOES quote the offending value: a
 * base URL is not a secret, and a typo in one is unfindable without seeing it.
 */
export function config(options: ComfyConfig): void {
  if ("credentials" in options) setCredentials(options.credentials);
  if ("baseUrl" in options) setBaseUrl(options.baseUrl);
}

function setCredentials(value: string | undefined): void {
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

function setBaseUrl(value: string | undefined): void {
  if (value === undefined) {
    configuredBaseUrl = undefined;
    return;
  }
  if (typeof value !== "string") {
    throw new TypeError(`config({ baseUrl }) must be a string or undefined, got ${typeof value}`);
  }
  configuredBaseUrl = validateBaseUrl(value.trim(), "config({ baseUrl })");
}

/**
 * An http(s) origin with no query or fragment, and no trailing slash.
 *
 * The same constraint the class client puts on `COMFY_BASE_URL`, for the
 * same reason: request paths are appended to this string, so a query or
 * fragment would land in the middle of every URL.
 */
function validateBaseUrl(raw: string, label: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = undefined;
  }
  const valid =
    parsed !== undefined &&
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.search === "" &&
    parsed.hash === "";
  if (!valid) {
    throw new TypeError(
      `${label} must be an http(s) URL with no query or fragment (e.g. "https://api.comfy.org"), got ${JSON.stringify(raw)}`,
    );
  }
  return raw.replace(/\/$/, "");
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

/**
 * The base URL in force for `comfy.*` calls: whatever {@link config} set,
 * else `COMFY_ROUTER_BASE_URL` from the environment, else
 * {@link COMFY_ROUTER_BASE_URL}. Never has a trailing slash.
 *
 * Read at call time, for the same reasons as {@link resolveCredentials}. A
 * malformed environment value throws rather than silently falling back to
 * the default: a process that set the variable meant to be pointed
 * somewhere, and quietly calling production instead is the worse failure.
 */
export function resolveBaseUrl(): string {
  if (configuredBaseUrl !== undefined) return configuredBaseUrl;
  const fromEnv = globalThis.process?.env?.[ROUTER_BASE_URL_ENV_VAR]?.trim();
  if (!fromEnv) return COMFY_ROUTER_BASE_URL;
  return validateBaseUrl(fromEnv, ROUTER_BASE_URL_ENV_VAR);
}
