/** `comfy.config({ credentials })`, the environment fallback, and redaction. */
import util from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Comfy,
  comfy,
  config,
  CREDENTIALS_ENV_VAR,
  MissingCredentials,
  ModelRunNotImplemented,
  resolveCredentials,
} from "./index.js";

const SECRET = "comfyui-test-credential-do-not-log";
const ENV_SECRET = "comfyui-from-the-environment";

beforeEach(() => {
  // The ambient shell may export a real key; neutralize it so these tests
  // measure the SDK rather than the operator's environment.
  vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
  config({ credentials: undefined });
});

afterEach(() => {
  config({ credentials: undefined });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("comfy.config({ credentials })", () => {
  it("names the environment variable", () => {
    expect(CREDENTIALS_ENV_VAR).toBe("COMFY_API_KEY");
  });

  it("sets the credential used by subsequent calls", () => {
    expect(resolveCredentials()).toBeUndefined();
    comfy.config({ credentials: SECRET });
    expect(resolveCredentials()).toBe(SECRET);
  });

  it("is the same function reached as a namespace member or a named import", () => {
    expect(comfy.config).toBe(config);
  });

  it("leaves the credential alone when the key is absent", () => {
    config({ credentials: SECRET });
    config({});
    expect(resolveCredentials()).toBe(SECRET);
  });

  it("clears the credential on an explicit undefined", () => {
    config({ credentials: SECRET });
    config({ credentials: undefined });
    expect(resolveCredentials()).toBeUndefined();
  });

  it("re-exposes the environment fallback after a clear", () => {
    vi.stubEnv(CREDENTIALS_ENV_VAR, ENV_SECRET);
    config({ credentials: SECRET });
    expect(resolveCredentials()).toBe(SECRET);
    config({ credentials: undefined });
    expect(resolveCredentials()).toBe(ENV_SECRET);
  });

  it("rejects a blank credential rather than silently falling through", () => {
    vi.stubEnv(CREDENTIALS_ENV_VAR, ENV_SECRET);
    expect(() => config({ credentials: "   " })).toThrow(TypeError);
    // The bad call must not have quietly demoted us to the environment.
    expect(resolveCredentials()).toBe(ENV_SECRET);
  });

  it("rejects a non-string credential", () => {
    expect(() => config({ credentials: 42 as unknown as string })).toThrow(
      /must be a string or undefined, got number/,
    );
  });
});

describe("credentials from the environment", () => {
  it("resolves COMFY_API_KEY when nothing was configured", () => {
    vi.stubEnv(CREDENTIALS_ENV_VAR, ENV_SECRET);
    expect(resolveCredentials()).toBe(ENV_SECRET);
  });

  it("trims the variable and treats a blank one as unset", () => {
    vi.stubEnv(CREDENTIALS_ENV_VAR, `  ${ENV_SECRET}  `);
    expect(resolveCredentials()).toBe(ENV_SECRET);
    vi.stubEnv(CREDENTIALS_ENV_VAR, "   ");
    expect(resolveCredentials()).toBeUndefined();
  });

  it("gives explicit config precedence over the environment", () => {
    vi.stubEnv(CREDENTIALS_ENV_VAR, ENV_SECRET);
    config({ credentials: SECRET });
    expect(resolveCredentials()).toBe(SECRET);
  });

  it("reads the variable per call, so a mid-run change is picked up", () => {
    vi.stubEnv(CREDENTIALS_ENV_VAR, ENV_SECRET);
    expect(resolveCredentials()).toBe(ENV_SECRET);
    vi.stubEnv(CREDENTIALS_ENV_VAR, "comfyui-rotated");
    expect(resolveCredentials()).toBe("comfyui-rotated");
  });

  it("degrades to undefined in a runtime with no process (a browser)", () => {
    vi.stubGlobal("process", undefined);
    expect(resolveCredentials()).toBeUndefined();
  });

  it("degrades to undefined when process carries no env", () => {
    vi.stubGlobal("process", {});
    expect(resolveCredentials()).toBeUndefined();
  });
});

/**
 * The credential must not be printable from anything the SDK hands back —
 * a bug report that pastes `console.log(client)` or `JSON.stringify(err)`
 * is the realistic leak path, and both were live before this change.
 */
describe("credential redaction", () => {
  function assertRedacted(label: string, value: unknown): void {
    expect(JSON.stringify(value) ?? "", `${label}: JSON.stringify`).not.toContain(SECRET);
    expect(util.inspect(value, { depth: 10 }), `${label}: util.inspect`).not.toContain(SECRET);
    expect(String(value), `${label}: String()`).not.toContain(SECRET);
  }

  it("keeps the configured credential out of the comfy namespace object", () => {
    config({ credentials: SECRET });
    assertRedacted("comfy", comfy);
    assertRedacted("comfy.models", comfy.models);
  });

  it("keeps the constructor apiKey out of a serialized client", () => {
    const client = new Comfy({ apiKey: SECRET, fetch: () => Promise.reject(new Error("no")) });
    assertRedacted("client", client);
    assertRedacted("client.jobs", client.jobs);
    assertRedacted("client.assets", client.assets);
  });

  it("keeps the credential out of a thrown MissingCredentials", async () => {
    const err = await comfy.models.run("owner/model", {}).catch((exc: unknown) => exc);
    expect(err).toBeInstanceOf(MissingCredentials);
    assertRedacted("MissingCredentials", err);
    expect((err as Error).stack ?? "").not.toContain(SECRET);
  });

  it("keeps the credential out of an error thrown while it is configured", async () => {
    config({ credentials: SECRET });
    const err = await comfy.models
      .run("owner/model", { prompt: SECRET })
      .catch((exc: unknown) => exc);
    expect(err).toBeInstanceOf(ModelRunNotImplemented);
    assertRedacted("ModelRunNotImplemented", err);
    expect((err as Error).stack ?? "").not.toContain(SECRET);
  });

  it("keeps the credential out of a config() type error", () => {
    const err = (() => {
      try {
        config({ credentials: { token: SECRET } as unknown as string });
        return undefined;
      } catch (exc) {
        return exc;
      }
    })();
    expect(err).toBeInstanceOf(TypeError);
    assertRedacted("TypeError", err);
  });

  it("still sends the credential on the wire — redaction is not removal", async () => {
    let auth: string | null = null;
    const client = new Comfy({
      apiKey: SECRET,
      fetch: (input, init) => {
        auth = new Headers(init?.headers).get("Authorization");
        void input;
        return Promise.reject(new Error("captured"));
      },
    });
    await client.jobs.get("j1").catch(() => {});
    expect(auth).toBe(`Bearer ${SECRET}`);
  });
});
