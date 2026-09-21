/** Comfy Cloud by default; `COMFY_BASE_URL` is the only way to change target. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASE_URL_ENV_VAR, COMFY_CLOUD_BASE_URL, Comfy, CREDENTIALS_ENV_VAR } from "./index.js";

const LOCAL = "http://127.0.0.1:8189";
// Every client here is constructed with an explicit key, so the ambient
// COMFY_API_KEY never reaches one and the credential question — which
// `apiKeyEnv.test.ts` owns — cannot decide a base-URL test.
const KEY = "comfyui-base-url-test";

/** Where a client actually sends a request, captured off its `fetch`. */
async function requestOrigin(): Promise<string> {
  let seen = "";
  const client = new Comfy({
    apiKey: KEY,
    fetch: (input) => {
      seen = new URL(input instanceof Request ? input.url : String(input)).origin;
      return Promise.reject(new Error("captured"));
    },
  });
  await client.jobs.get("j1").catch(() => {});
  return seen;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("base URL from the environment", () => {
  it("names the environment variable", () => {
    expect(BASE_URL_ENV_VAR).toBe("COMFY_BASE_URL");
  });

  it("points at Comfy Cloud", () => {
    expect(COMFY_CLOUD_BASE_URL).toBe("https://cloud.comfy.org");
  });

  it("requests Comfy Cloud when the variable is unset", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    expect(await requestOrigin()).toBe(COMFY_CLOUD_BASE_URL);
  });

  it("requests the deployment the variable names", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, LOCAL);
    expect(await requestOrigin()).toBe(LOCAL);
  });

  it("reads the variable per construction, not at module load", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    expect(await requestOrigin()).toBe(COMFY_CLOUD_BASE_URL);
    vi.stubEnv(BASE_URL_ENV_VAR, LOCAL);
    expect(await requestOrigin()).toBe(LOCAL);
  });

  it.each(["", "   "])("treats a blank value (%j) as Comfy Cloud", async (blank) => {
    vi.stubEnv(BASE_URL_ENV_VAR, blank);
    expect(await requestOrigin()).toBe(COMFY_CLOUD_BASE_URL);
  });

  it("ignores surrounding whitespace", async () => {
    vi.stubEnv(BASE_URL_ENV_VAR, `  ${LOCAL}  `);
    expect(await requestOrigin()).toBe(LOCAL);
  });

  it.each([
    "cloud.comfy.org",
    "ftp://cloud.comfy.org",
    "file:///etc/passwd",
    "http://127.0.0.1:bad",
    "http://127.0.0.1:99999",
    "https://cloud.comfy.org?x=1",
    "https://cloud.comfy.org#frag",
    "not a url",
  ])("rejects a malformed value (%j)", (bad) => {
    vi.stubEnv(BASE_URL_ENV_VAR, bad);
    expect(() => new Comfy({ apiKey: KEY })).toThrow(TypeError);
    expect(() => new Comfy({ apiKey: KEY })).toThrow(BASE_URL_ENV_VAR);
  });

  it("rejects a positional base URL instead of ignoring it", () => {
    // The pre-COMFY_BASE_URL form. TypeScript callers get a compile error;
    // untyped JS callers get this.
    expect(() => new (Comfy as unknown as new (url: string) => Comfy)(LOCAL)).toThrow(TypeError);
  });

  it("names a missing credential rather than the target, once the target is valid", () => {
    // The two environment variables are read in one order on purpose, and it
    // is the target first: `apiKeyEnv.test.ts` pins the rest of that rule.
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
    expect(() => new Comfy()).toThrow(CREDENTIALS_ENV_VAR);
  });
});
