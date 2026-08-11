/** Comfy Cloud by default; `COMFY_BASE_URL` is the only way to change target. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { BASE_URL_ENV_VAR, COMFY_CLOUD_BASE_URL, Comfy } from "./index.js";

const LOCAL = "http://127.0.0.1:8189";

/** The base URL a client resolved, read off the transport it built. */
function targetOf(client: Comfy): string {
  return (client as unknown as { low: { baseUrl: string } }).low.baseUrl;
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

  it("defaults to Comfy Cloud when the variable is unset", () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    expect(targetOf(new Comfy({ apiKey: "comfyui-test" }))).toBe(COMFY_CLOUD_BASE_URL);
  });

  it("targets the deployment the variable names", () => {
    vi.stubEnv(BASE_URL_ENV_VAR, LOCAL);
    expect(targetOf(new Comfy())).toBe(LOCAL);
  });

  it("reads the variable per construction, not at module load", () => {
    vi.stubEnv(BASE_URL_ENV_VAR, undefined);
    expect(targetOf(new Comfy())).toBe(COMFY_CLOUD_BASE_URL);
    vi.stubEnv(BASE_URL_ENV_VAR, LOCAL);
    expect(targetOf(new Comfy())).toBe(LOCAL);
  });

  it.each(["", "   "])("treats a blank value (%j) as Comfy Cloud", (blank) => {
    vi.stubEnv(BASE_URL_ENV_VAR, blank);
    expect(targetOf(new Comfy())).toBe(COMFY_CLOUD_BASE_URL);
  });

  it("ignores surrounding whitespace", () => {
    vi.stubEnv(BASE_URL_ENV_VAR, `  ${LOCAL}  `);
    expect(targetOf(new Comfy())).toBe(LOCAL);
  });

  it.each(["cloud.comfy.org", "ftp://cloud.comfy.org", "file:///etc/passwd", "not a url"])(
    "rejects a malformed value (%j)",
    (bad) => {
      vi.stubEnv(BASE_URL_ENV_VAR, bad);
      expect(() => new Comfy()).toThrow(TypeError);
      expect(() => new Comfy()).toThrow(BASE_URL_ENV_VAR);
    },
  );

  it("rejects a positional base URL instead of ignoring it", () => {
    // The pre-COMFY_BASE_URL form. TypeScript callers get a compile error;
    // untyped JS callers get this.
    expect(() => new (Comfy as unknown as new (url: string) => Comfy)(LOCAL)).toThrow(TypeError);
  });
});
