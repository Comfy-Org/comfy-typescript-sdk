/**
 * Live end-to-end test of the Router model-run surface (`comfy.models.run`)
 * against a deployment, exercising the alt-provider controls (`modelProvider`,
 * `strictMode`, `fallbackProvider`) added on this branch.
 *
 * Skipped unless pointed at a live Router deployment:
 *
 *     export COMFY_ROUTER_E2E=1            # required: these calls BILL
 *     export COMFY_ROUTER_BASE_URL="https://stagingapi.comfy.org"
 *     export COMFY_API_KEY="comfyui-..."
 *     pnpm test test/integration/router-models-e2e.test.ts
 *
 * Gated on COMFY_ROUTER_E2E=1 as well as the credentials, so an ordinary
 * `pnpm test` with staging credentials exported cannot bill:
 * these calls dispatch real partner generations and cost credits, so they run
 * only against a deployment the caller deliberately named, never accidentally
 * against the default prod host. The provider under test defaults to `fal` and
 * the model ids to fal's registered alt-provider legs; override with
 * COMFY_ROUTER_E2E_PROVIDER / _IMAGE_MODEL / _VIDEO_MODEL to point elsewhere.
 *
 * The provider gate must be enabled for the caller on the target deployment, or
 * these are refused `not_enabled` (that refusal is itself the signal the gate
 * is off, not an SDK fault).
 *
 * The TypeScript sibling of the Python SDK's
 * `tests/integration/test_router_models_e2e.py`. Two shapes differ from that
 * file and are intentional, not parity gaps:
 *
 * - `run` resolves the wrapped `{ kind, data, requestId }` result (see
 *   `RunResult`), so the provider's native payload is `result.data`, reached
 *   only after narrowing `result.kind === "json"`.
 * - There is no separate async client — JS is async-native, so `run` IS the
 *   awaitable form. The Python async-client case maps to invoking that same
 *   form through the other documented entrypoint (the top-level `models`
 *   export rather than the `comfy.models` namespace).
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  comfy,
  CREDENTIALS_ENV_VAR,
  models,
  ROUTER_BASE_URL_ENV_VAR,
} from "../../src/sdk/index.js";

const ROUTER_BASE_URL = process.env[ROUTER_BASE_URL_ENV_VAR];
const API_KEY = process.env[CREDENTIALS_ENV_VAR];
const PROVIDER = process.env.COMFY_ROUTER_E2E_PROVIDER ?? "fal";
// Native model ids that carry an alt-provider leg — the {provider}/{model} the
// run route is addressed by, not the alt-provider's own catalog id.
const IMAGE_MODEL = process.env.COMFY_ROUTER_E2E_IMAGE_MODEL ?? "openai/gpt-image-2";
const VIDEO_MODEL =
  process.env.COMFY_ROUTER_E2E_VIDEO_MODEL ?? "byteplus/dreamina-seedance-2-0-260128";

const RUN_TIMEOUT_MS = 300_000; // a direct image generation, held server-side
const VIDEO_TIMEOUT_MS = 600_000; // submit-poll video, polled server-side inside the call
// A margin over each server-side deadline so a slow-but-live call still fails
// as an assertion rather than as a Vitest timeout that hides the real result.
const TEST_MARGIN_MS = 30_000;

// These calls BILL. The opt-in is a dedicated variable, deliberately not the
// SDK's own documented credentials: `COMFY_ROUTER_BASE_URL` + `COMFY_API_KEY`
// are exactly what a developer pointed at staging has exported already, and
// `vitest.config.ts` sets no `test.include`, so vitest's default glob reaches
// this file on a plain `pnpm test`. Gating on credentials alone therefore means
// an ordinary local test run silently spends money on an image AND a video
// generation. `COMFY_ROUTER_E2E=1` is the same opt-in the cloud repo's Router
// e2e suite uses, so the two agree on what "yes, bill me" looks like.
const E2E_OPT_IN = process.env.COMFY_ROUTER_E2E === "1";
const shouldRun = Boolean(E2E_OPT_IN && ROUTER_BASE_URL && API_KEY);

/** The image URL/data-URI from a native OpenAI-image response, or "". */
function imageUrl(data: unknown): string {
  if (data === null || typeof data !== "object") return "";
  const list = (data as { data?: unknown }).data;
  if (!Array.isArray(list) || list.length === 0) return "";
  const first = list[0];
  if (first === null || typeof first !== "object") return "";
  const entry = first as { url?: unknown; b64_json?: unknown };
  if (typeof entry.url === "string") return entry.url;
  if (typeof entry.b64_json === "string") return entry.b64_json;
  return "";
}

describe.skipIf(!shouldRun)("Router model-run e2e (live)", () => {
  beforeAll(() => {
    // Set explicitly, mirroring the Python client taking the key directly, so
    // the suite does not depend on a prior test's module config. Both are
    // guaranteed non-empty here — the suite is skipped otherwise.
    comfy.config({ credentials: API_KEY, baseUrl: ROUTER_BASE_URL });
  });

  it(
    "translates a native round-trip on an image model via model_provider",
    async () => {
      // strictMode defaults to false: native input in, native output back, with
      // the alt-provider translation invisible — the point of the default path.
      const result = await comfy.models.run(
        IMAGE_MODEL,
        { prompt: "a red fox in a snowy forest", n: 1, size: "1024x1024" },
        { modelProvider: PROVIDER, timeoutMs: RUN_TIMEOUT_MS },
      );
      expect(result.kind).toBe("json");
      if (result.kind !== "json") return;
      expect(imageUrl(result.data)).not.toBe("");
    },
    RUN_TIMEOUT_MS + TEST_MARGIN_MS,
  );

  it(
    "returns the provider's raw shape under strict_mode",
    async () => {
      // strictMode=true: the body is the provider's OWN shape, passed through,
      // and the response is the provider's raw shape — no native translation.
      const result = await comfy.models.run(
        IMAGE_MODEL,
        { prompt: "a red fox, oil painting", image_size: { width: 1024, height: 1024 } },
        { modelProvider: PROVIDER, strictMode: true, timeoutMs: RUN_TIMEOUT_MS },
      );
      expect(result.kind).toBe("json");
      if (result.kind !== "json") return;
      const data = result.data as Record<string, unknown>;
      expect(data !== null && typeof data === "object").toBe(true);
      // The provider's own shape, not the native `data[]` envelope.
      expect(!("data" in data) || "images" in data).toBe(true);
    },
    RUN_TIMEOUT_MS + TEST_MARGIN_MS,
  );

  it(
    "accepts fallback_provider='false'",
    async () => {
      // Only changes behavior on a primary failure, so on success it is a no-op:
      // the call still succeeds and returns the native image.
      const result = await comfy.models.run(
        IMAGE_MODEL,
        { prompt: "a red fox, watercolor", n: 1, size: "1024x1024" },
        { modelProvider: PROVIDER, fallbackProvider: "false", timeoutMs: RUN_TIMEOUT_MS },
      );
      expect(result.kind).toBe("json");
      if (result.kind !== "json") return;
      expect(imageUrl(result.data)).not.toBe("");
    },
    RUN_TIMEOUT_MS + TEST_MARGIN_MS,
  );

  it(
    "carries the same params through the top-level models export",
    async () => {
      // The awaitable form via the other documented entrypoint (the `models`
      // export rather than the `comfy.models` namespace) — the async-native
      // stand-in for Python's separate async client. Same params, same result.
      const result = await models.run(
        IMAGE_MODEL,
        { prompt: "a red fox, pixel art", n: 1, size: "1024x1024" },
        { modelProvider: PROVIDER, timeoutMs: RUN_TIMEOUT_MS },
      );
      expect(result.kind).toBe("json");
      if (result.kind !== "json") return;
      expect(imageUrl(result.data)).not.toBe("");
    },
    RUN_TIMEOUT_MS + TEST_MARGIN_MS,
  );

  it(
    "runs a submit-poll video model via the alt provider",
    async () => {
      // A submit-and-poll (video) model served via the alt provider: run() blocks
      // while the server polls to completion and the native terminal shape comes
      // back. This is the second dispatch mode (the image models above are direct).
      const result = await comfy.models.run(
        VIDEO_MODEL,
        {
          content: [{ type: "text", text: "a red fox running through a snowy forest" }],
          resolution: "480p",
          ratio: "16:9",
          duration: 5,
        },
        { modelProvider: PROVIDER, timeoutMs: VIDEO_TIMEOUT_MS },
      );
      expect(result.kind).toBe("json");
      if (result.kind !== "json") return;
      const data = result.data as { status?: unknown; content?: unknown };
      expect(data.status).toBe("succeeded");
      const content =
        data.content !== null && typeof data.content === "object"
          ? (data.content as { video_url?: unknown })
          : {};
      expect(typeof content.video_url === "string" && content.video_url !== "").toBe(true);
    },
    VIDEO_TIMEOUT_MS + TEST_MARGIN_MS,
  );
});
