/** `comfy.models` reachability and the local, no-network credential gate. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  comfy,
  ComfyError,
  config,
  CREDENTIALS_ENV_VAR,
  MissingCredentials,
  ModelRunNotImplemented,
  models,
} from "./index.js";

/** Any socket attempt at all fails the test that made it. */
function forbidNetwork(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(() => Promise.reject(new Error("network call attempted")));
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  vi.stubEnv(CREDENTIALS_ENV_VAR, undefined);
  config({ credentials: undefined });
});

afterEach(() => {
  config({ credentials: undefined });
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the comfy.models namespace", () => {
  it("is reachable off the comfy namespace and as a named export", () => {
    expect(comfy.models).toBe(models);
    expect(comfy.models.run).toBeTypeOf("function");
  });

  it("is frozen, so a consumer cannot swap the shared namespace out", () => {
    expect(Object.isFrozen(comfy)).toBe(true);
    expect(Object.isFrozen(comfy.models)).toBe(true);
  });
});

describe("comfy.models.run without credentials", () => {
  it("rejects with the named MissingCredentials error", async () => {
    forbidNetwork();
    await expect(comfy.models.run("owner/model", {})).rejects.toBeInstanceOf(MissingCredentials);
  });

  it("names both ways to supply a credential", async () => {
    forbidNetwork();
    const err = (await comfy.models.run("owner/model", {}).catch((e: unknown) => e)) as ComfyError;
    expect(err.message).toContain("comfy.config({ credentials");
    expect(err.message).toContain(CREDENTIALS_ENV_VAR);
    expect(err.code).toBe("missing_credentials");
    expect(err).toBeInstanceOf(ComfyError);
    expect(err.name).toBe("MissingCredentials");
  });

  it("throws locally — no request is made", async () => {
    const fetchSpy = forbidNetwork();
    await comfy.models.run("owner/model", {}).catch(() => {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("comfy.models.run with credentials", () => {
  it("gets past the credential gate and reports the unimplemented route", async () => {
    forbidNetwork();
    config({ credentials: "comfyui-configured" });
    const err = (await comfy.models.run("owner/model", {}).catch((e: unknown) => e)) as ComfyError;
    expect(err).toBeInstanceOf(ModelRunNotImplemented);
    expect(err).not.toBeInstanceOf(MissingCredentials);
    expect(err.code).toBe("model_run_not_implemented");
  });

  it("points at the workflow path that does work today", async () => {
    forbidNetwork();
    config({ credentials: "comfyui-configured" });
    const err = (await comfy.models.run("owner/model", {}).catch((e: unknown) => e)) as ComfyError;
    expect(err.message).toContain("new Comfy({ apiKey }).run(workflow)");
  });

  it("accepts a credential supplied only by the environment", async () => {
    forbidNetwork();
    vi.stubEnv(CREDENTIALS_ENV_VAR, "comfyui-from-env");
    await expect(comfy.models.run("owner/model", {})).rejects.toBeInstanceOf(
      ModelRunNotImplemented,
    );
  });

  it("still opens no socket", async () => {
    const fetchSpy = forbidNetwork();
    config({ credentials: "comfyui-configured" });
    await comfy.models.run("owner/model", {}).catch(() => {});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
