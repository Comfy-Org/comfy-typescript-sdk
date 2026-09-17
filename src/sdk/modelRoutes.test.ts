/** `routerRunQuery` — the alt-provider query string for a model run, built
 * sans-IO: present only when set, in a fixed order, `strict_mode` as
 * `true`/`false`. */
import { describe, expect, it } from "vitest";

import { routerRunQuery } from "./modelRoutes.js";

describe("routerRunQuery", () => {
  it("is empty when the caller named no control, so the request is unchanged", () => {
    // The whole point: a run that sets none of the three appends no query at
    // all, and is byte-for-byte the request this route has always made.
    expect(routerRunQuery({})).toBe("");
    expect(routerRunQuery({ modelProvider: undefined })).toBe("");
    expect(
      routerRunQuery({
        modelProvider: undefined,
        strictMode: undefined,
        fallbackProvider: undefined,
      }),
    ).toBe("");
  });

  it("emits each control only when it is set", () => {
    expect(routerRunQuery({ modelProvider: "fal" })).toBe("model_provider=fal");
    expect(routerRunQuery({ fallbackProvider: "false" })).toBe("fallback_provider=false");
  });

  it("renders strict_mode as the spec's true/false, including the default-shaped false", () => {
    // `false` is emitted when the caller passes it — that is the caller asking
    // for the default explicitly, which is still a value they set — and it
    // renders as `false`, not `0` or the omitted case.
    expect(routerRunQuery({ strictMode: true })).toBe("strict_mode=true");
    expect(routerRunQuery({ strictMode: false })).toBe("strict_mode=false");
  });

  it("orders the three model_provider, strict_mode, fallback_provider", () => {
    expect(
      routerRunQuery({ modelProvider: "fal", strictMode: false, fallbackProvider: "false" }),
    ).toBe("model_provider=fal&strict_mode=false&fallback_provider=false");
    // Insertion order is fixed regardless of the object's own key order.
    expect(
      routerRunQuery({ fallbackProvider: "false", strictMode: true, modelProvider: "replicate" }),
    ).toBe("model_provider=replicate&strict_mode=true&fallback_provider=false");
  });

  it("percent-encodes a provider value rather than letting it break the query", () => {
    expect(routerRunQuery({ modelProvider: "a b&c" })).toBe("model_provider=a+b%26c");
  });
});
