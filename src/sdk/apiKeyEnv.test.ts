/**
 * Credential resolution for the class client: explicit `apiKey`, then
 * `COMFY_API_KEY`, then a local error against Comfy Cloud.
 *
 * Every test stubs BOTH environment variables, deliberately: an ambient
 * developer key or a redirected base URL in the shell that runs `pnpm test`
 * would otherwise decide the answer, and the one thing this file exists to
 * pin is which source a client reads.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BASE_URL_ENV_VAR,
  COMFY_CLOUD_BASE_URL,
  Comfy,
  CREDENTIALS_ENV_VAR,
  MissingCredentials,
  type ComfyOptions,
} from "./index.js";

const LOCAL = "http://127.0.0.1:8189";
const EXPLICIT = "comfyui-explicit";
const FROM_ENV = "comfyui-from-env";

/** The `Authorization` header a client actually sends, captured off its `fetch`. */
async function authorization(options: ComfyOptions = {}): Promise<string | null> {
  let seen: string | null = null;
  const client = new Comfy({
    ...options,
    fetch: (_input, init) => {
      seen = new Headers(init?.headers).get("Authorization");
      return Promise.reject(new Error("captured"));
    },
  });
  await client.jobs.get("j1").catch(() => {});
  return seen;
}

/** A client that would make a request if one were ever attempted. */
function construct(options: ComfyOptions = {}): Comfy {
  return new Comfy({ ...options, fetch: () => Promise.reject(new Error("unreachable")) });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the class client's API key", () => {
  it("reads the same environment variable the `comfy.*` namespace does", () => {
    expect(CREDENTIALS_ENV_VAR).toBe("COMFY_API_KEY");
  });

  it("sends the explicit apiKey when one is passed", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    expect(await authorization({ apiKey: EXPLICIT })).toBe(`Bearer ${EXPLICIT}`);
  });

  it("falls back to the environment when no apiKey is passed", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, FROM_ENV);
    expect(await authorization()).toBe(`Bearer ${FROM_ENV}`);
  });

  it("prefers an explicit apiKey over the environment", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, FROM_ENV);
    expect(await authorization({ apiKey: EXPLICIT })).toBe(`Bearer ${EXPLICIT}`);
  });

  it("reads the variable per construction, not at module load", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, FROM_ENV);
    expect(await authorization()).toBe(`Bearer ${FROM_ENV}`);
    vi.stubEnv(CREDENTIALS_ENV_VAR, "comfyui-rotated");
    expect(await authorization()).toBe("Bearer comfyui-rotated");
  });

  it.each(["", "   ", "\n"])("treats a blank variable (%j) as unset", (blank) => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, blank);
    expect(() => construct()).toThrow(MissingCredentials);
  });

  it.each(["", "   "])(
    "treats a blank apiKey (%j) as unset and reads the environment",
    async (blank) => {
      vi.stubEnv(BASE_URL_ENV_VAR, undefined);
      vi.stubEnv(CREDENTIALS_ENV_VAR, FROM_ENV);
      expect(await authorization({ apiKey: blank })).toBe(`Bearer ${FROM_ENV}`);
    },
  );

  it("ignores surrounding whitespace at either source", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    // A key read out of a file arrives with the file's trailing newline.
    vi.stubEnv(CREDENTIALS_ENV_VAR, `  ${FROM_ENV}\n`);
    expect(await authorization()).toBe(`Bearer ${FROM_ENV}`);
    expect(await authorization({ apiKey: ` ${EXPLICIT} ` })).toBe(`Bearer ${EXPLICIT}`);
  });

  it("rejects a non-string apiKey instead of silently using the environment", () => {
    // Untyped JS callers get no compile error. Falling through would
    // authenticate as whatever COMFY_API_KEY names while the caller believes
    // they supplied a key.
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, FROM_ENV);
    expect(() => construct({ apiKey: 12345 as unknown as string })).toThrow(TypeError);
    // The message names the type, never the value.
    expect(() => construct({ apiKey: 12345 as unknown as string })).toThrow(/got number/);
    expect(() => construct({ apiKey: 12345 as unknown as string })).not.toThrow(/12345/);
  });
});

describe("no credential at all", () => {
  it("throws MissingCredentials against Comfy Cloud, before any network call", () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    let attempts = 0;
    expect(
      () =>
        new Comfy({
          fetch: () => {
            attempts += 1;
            return Promise.reject(new Error("should never be reached"));
          },
        }),
    ).toThrow(MissingCredentials);
    expect(attempts, "a missing credential must not cost a round trip").toBe(0);
  });

  it("names both ways to supply one, and how to target a keyless deployment", () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    expect(() => construct()).toThrow(/apiKey/);
    expect(() => construct()).toThrow(CREDENTIALS_ENV_VAR);
    expect(() => construct()).toThrow(BASE_URL_ENV_VAR);
    expect(() => construct()).toThrow(COMFY_CLOUD_BASE_URL);
  });

  it("carries the same code the `comfy.*` namespace raises", () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    try {
      construct();
      expect.unreachable("construction should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingCredentials);
      expect((error as MissingCredentials).code).toBe("missing_credentials");
    }
  });

  it("sends no credential, and does not throw, against another deployment", async () => {
    // Today's keyless local-dev flow: a self-hosted ComfyUI behind the API
    // proxy legitimately has no key.
    vi.stubEnv(BASE_URL_ENV_VAR, LOCAL);
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    expect(await authorization()).toBeNull();
  });

  it.each([
    "https://cloud.comfy.org:443",
    "https://cloud.comfy.org/",
    "HTTPS://cloud.comfy.org",
    // Doubled trailing slashes -- what string-concatenating a base URL with a
    // "/" prefix produces. Python's `_same_deployment` rstrips them all, so
    // stripping only the last one here would be a silent cross-SDK divergence
    // in the unsafe direction: a keyless client aimed at Comfy Cloud.
    "https://cloud.comfy.org//",
    "https://cloud.comfy.org:443//",
  ])("still recognizes Comfy Cloud written as %j", (spelling) => {
    // Compared by normalized origin and path, not by string: reading one of
    // these as *some other* deployment would hand back a keyless client and a
    // server 401 instead of this local error.
    vi.stubEnv(BASE_URL_ENV_VAR, spelling);
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    expect(() => construct()).toThrow(MissingCredentials);
  });

  it("treats a deployment mounted under the same host as a different target", async () => {
    // The keyless carve-out has to keep applying to it.
    vi.stubEnv(BASE_URL_ENV_VAR, "https://cloud.comfy.org/self-hosted");
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    expect(await authorization()).toBeNull();
  });

  it("checks the target before the credential, so a malformed base URL still wins", () => {
    // A TypeError naming COMFY_BASE_URL is the more actionable of the two, and
    // the credential question is not even well-posed until the target is known.
    vi.stubEnv(BASE_URL_ENV_VAR, "not a url");
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    expect(() => construct()).toThrow(TypeError);
    expect(() => construct()).toThrow(BASE_URL_ENV_VAR);
  });
});
