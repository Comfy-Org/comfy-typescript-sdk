import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  ClientDisconnected,
  ConcurrencyLimitExceeded,
  ContentPolicyViolation,
  DeadlineExceeded,
  ERROR_TYPE_HEADER,
  Forbidden,
  InsufficientCredits,
  InternalError,
  InvalidInput,
  ModelNotFound,
  NotEnabled,
  ProviderError,
  ProviderTimeout,
  RateLimited,
  REQUEST_ERROR_TYPES,
  REQUEST_ID_HEADER,
  ROUTER_ERROR_TYPES,
  RouterError,
  ServiceUnavailable,
  TRANSPORT_ERROR_TYPES,
  Unauthorized,
  toRouterError,
  type RouterErrorType,
  type ValidationErrorDetail,
} from "./routerErrors.js";

/** The bucket → class table, stated here independently of the module's own. */
const CLASSES: Array<[RouterErrorType, typeof RouterError]> = [
  ["invalid_input", InvalidInput],
  ["content_policy_violation", ContentPolicyViolation],
  ["provider_error", ProviderError],
  ["provider_timeout", ProviderTimeout],
  ["insufficient_credits", InsufficientCredits],
  ["model_not_found", ModelNotFound],
  ["unauthorized", Unauthorized],
  ["forbidden", Forbidden],
  ["concurrency_limit_exceeded", ConcurrencyLimitExceeded],
  ["client_disconnected", ClientDisconnected],
  ["internal_error", InternalError],
  ["deadline_exceeded", DeadlineExceeded],
  ["not_enabled", NotEnabled],
  ["service_unavailable", ServiceUnavailable],
  ["rate_limited", RateLimited],
];

/**
 * A stubbed Router error response. Real `Response`/`Headers` objects, so the
 * case-insensitive header lookup and the JSON round-trip are exercised rather
 * than assumed away by a hand-rolled fake.
 */
function stubErrorResponse(
  status: number,
  body: unknown,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function raise(response: Response): Promise<never> {
  throw toRouterError(response.status, response.headers, await response.json());
}

describe("the closed error-type set", () => {
  it("is the six request-level buckets plus the nine transport-level ones", () => {
    expect(REQUEST_ERROR_TYPES).toHaveLength(6);
    expect(TRANSPORT_ERROR_TYPES).toHaveLength(9);
    expect(ROUTER_ERROR_TYPES).toEqual([...REQUEST_ERROR_TYPES, ...TRANSPORT_ERROR_TYPES]);
    expect(new Set(ROUTER_ERROR_TYPES).size).toBe(15);
  });

  it("has exactly one class per bucket, and no class outside it", () => {
    expect(CLASSES.map(([type]) => type)).toEqual([...ROUTER_ERROR_TYPES]);
    expect(new Set(CLASSES.map(([, cls]) => cls)).size).toBe(ROUTER_ERROR_TYPES.length);
  });

  it("declares each class's own errorType, matching its bucket", () => {
    for (const [type, cls] of CLASSES) {
      expect(cls.errorType).toBe(type);
    }
  });

  it("omits the buckets deferred past this release", () => {
    // Adding one of these is a decision someone makes on purpose, in lockstep
    // with the server and the sibling SDK — not a constant that quietly widens
    // a set two SDKs build their exception hierarchies from.
    for (const deferred of ["file_download_error", "cancelled", "queue_timeout"]) {
      expect(ROUTER_ERROR_TYPES).not.toContain(deferred);
    }
  });
});

describe("the class hierarchy", () => {
  it.each(CLASSES)("%s is a RouterError and an Error", (_type, cls) => {
    const err = new cls("boom");
    expect(err).toBeInstanceOf(cls);
    expect(err).toBeInstanceOf(RouterError);
    expect(err).toBeInstanceOf(Error);
  });

  it.each(CLASSES)("%s carries its own name for logs and stack traces", (_type, cls) => {
    const err = new cls("boom");
    expect(err.name).toBe(cls.name);
    expect(String(err)).toBe(`${cls.name}: boom`);
    expect(err.stack).toContain(cls.name);
  });

  it("defaults a bare RouterError to internal_error without rewriting a known one", () => {
    expect(new RouterError("boom").errorType).toBe("internal_error");
    expect(new RouterError("boom", { errorType: "queue_timeout" }).errorType).toBe("queue_timeout");
  });

  it("carries requestId and httpStatus on every class, defaulting to null", () => {
    for (const [, cls] of CLASSES) {
      const carried = new cls("boom", { requestId: "req-1", httpStatus: 502 });
      expect(carried.requestId).toBe("req-1");
      expect(carried.httpStatus).toBe(502);

      const bare = new cls("boom");
      expect(bare.requestId).toBeNull();
      expect(bare.httpStatus).toBeNull();
    }
  });
});

describe("instanceof under an ES5 down-level build", () => {
  // Extending a built-in is the classic `instanceof` trap: a consumer who
  // down-levels this package's ES2022 output to ES5 gets a constructor whose
  // returned object is chained to `Error.prototype`, so `err instanceof
  // ContentPolicyViolation` is false for an error the SDK itself threw. The
  // `Object.setPrototypeOf` line in the module is what prevents it — deleting
  // that line makes this suite fail, which is the point of testing the built
  // output rather than asserting the chain in the same target that authored it.
  //
  // The module is transpiled and evaluated in isolation, which it can be
  // because it imports nothing.
  const source = readFileSync(
    fileURLToPath(new URL("./routerErrors.ts", import.meta.url)),
    "utf-8",
  );

  function buildEs5(src: string): Record<string, any> {
    const { outputText } = ts.transpileModule(src, {
      compilerOptions: { target: ts.ScriptTarget.ES5, module: ts.ModuleKind.CommonJS },
    });
    const moduleExports: Record<string, any> = {};
    new Function("exports", "require", outputText)(moduleExports, () => {
      throw new Error("the ES5 build must not require anything");
    });
    return moduleExports;
  }

  const es5 = buildEs5(source);

  it.each(CLASSES.map(([type, cls]) => [type, cls.name] as const))(
    "%s survives the down-level as an instanceof-checkable class",
    (type, className) => {
      const err = es5.toRouterError(400, new Headers({ [ERROR_TYPE_HEADER]: type }), {
        detail: "boom",
      });
      expect(err).toBeInstanceOf(es5[className]);
      expect(err).toBeInstanceOf(es5.RouterError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe(className);
    },
  );

  it("fails without the explicit prototype restoration (the guard is load-bearing)", () => {
    const unguarded = buildEs5(source.replace(/^\s*Object\.setPrototypeOf\(.*\n/m, ""));
    expect(source).toMatch(/Object\.setPrototypeOf\(this, new\.target\.prototype\);/);
    expect(new unguarded.ContentPolicyViolation("boom")).not.toBeInstanceOf(
      unguarded.ContentPolicyViolation,
    );
  });
});

describe("toRouterError", () => {
  it.each(CLASSES)(
    "throws and catches %s from a stubbed error response",
    async (type, expectedClass) => {
      const response = stubErrorResponse(
        400,
        { detail: "the server said no", error_type: type },
        { [ERROR_TYPE_HEADER]: type, [REQUEST_ID_HEADER]: "6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21" },
      );

      let caught: unknown;
      try {
        await raise(response);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(expectedClass);
      const err = caught as RouterError;
      expect(err.errorType).toBe(type);
      expect(err.message).toBe("the server said no");
      expect(err.requestId).toBe("6f1a1a6e-6a53-4a5f-9d3a-2b3b0a1f9c21");
      expect(err.httpStatus).toBe(400);
    },
  );

  it("reads the bucket off the header even when the body disagrees", () => {
    // The header is the contract: the 422 body carries no error_type at all,
    // so a body field can never be the primary source.
    const err = toRouterError(
      400,
      new Headers({ [ERROR_TYPE_HEADER]: "content_policy_violation" }),
      { detail: "refused", error_type: "provider_error" },
    );
    expect(err).toBeInstanceOf(ContentPolicyViolation);
  });

  it("falls back to the body's error_type when the header is absent", () => {
    const err = toRouterError(502, new Headers(), {
      detail: "upstream said no",
      error_type: "provider_error",
    });
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.errorType).toBe("provider_error");
  });

  it("falls back to the status when neither header nor body names a bucket", () => {
    expect(toRouterError(401, new Headers(), null)).toBeInstanceOf(Unauthorized);
    expect(toRouterError(402, new Headers(), null)).toBeInstanceOf(InsufficientCredits);
    expect(toRouterError(404, new Headers(), null)).toBeInstanceOf(ModelNotFound);
    expect(toRouterError(429, new Headers(), null)).toBeInstanceOf(ConcurrencyLimitExceeded);
    expect(toRouterError(499, new Headers(), null)).toBeInstanceOf(ClientDisconnected);
    expect(toRouterError(502, new Headers(), null)).toBeInstanceOf(ProviderError);
    expect(toRouterError(504, new Headers(), null)).toBeInstanceOf(ProviderTimeout);
  });

  it("keeps naming the older bucket where two of them share a status", () => {
    // `not_enabled`, `rate_limited` and `deadline_exceeded` share 403, 429 and
    // 504 with an older bucket, and a response with no header carries no
    // evidence of which one it is. The fallback table is for responses that
    // never reached Router at all, so it keeps the answer it has always given
    // rather than relabelling those failures on the least evidence available;
    // the header is what disambiguates, and Router always sets it.
    const headerless = new Headers();
    expect(toRouterError(403, headerless, null)).toBeInstanceOf(Forbidden);
    expect(toRouterError(403, headerless, null).errorType).toBe("forbidden");
    expect(toRouterError(429, headerless, null)).toBeInstanceOf(ConcurrencyLimitExceeded);
    expect(toRouterError(504, headerless, null)).toBeInstanceOf(ProviderTimeout);
  });

  it("falls back to InternalError for a status with no mapping", () => {
    // 503 is deliberately unmapped: far more often a load balancer with no
    // Router behind it than Router's own `service_unavailable`, which arrives
    // with the header set and resolves through it.
    const err = toRouterError(503, new Headers(), null);
    expect(err).toBeInstanceOf(InternalError);
    expect(err.message).toBe("HTTP 503");
  });

  it("resolves the buckets that only the header can name", () => {
    const notEnabled = toRouterError(
      403,
      new Headers({ [ERROR_TYPE_HEADER]: "not_enabled", [REQUEST_ID_HEADER]: "req-403" }),
      { detail: "Comfy Router is not switched on for this caller yet.", error_type: "not_enabled" },
    );
    expect(notEnabled).toBeInstanceOf(NotEnabled);
    expect(notEnabled).not.toBeInstanceOf(Forbidden);
    expect(notEnabled.errorType).toBe("not_enabled");
    expect(notEnabled.httpStatus).toBe(403);
    expect(notEnabled.requestId).toBe("req-403");
    expect(notEnabled.message).toBe("Comfy Router is not switched on for this caller yet.");

    const unavailable = toRouterError(
      503,
      new Headers({ [ERROR_TYPE_HEADER]: "service_unavailable", [REQUEST_ID_HEADER]: "req-503" }),
      { detail: "a dependency is down; retry with backoff", error_type: "service_unavailable" },
    );
    expect(unavailable).toBeInstanceOf(ServiceUnavailable);
    expect(unavailable).not.toBeInstanceOf(InternalError);
    expect(unavailable.errorType).toBe("service_unavailable");
    expect(unavailable.httpStatus).toBe(503);
    expect(unavailable.requestId).toBe("req-503");

    expect(
      toRouterError(429, new Headers({ [ERROR_TYPE_HEADER]: "rate_limited" }), null),
    ).toBeInstanceOf(RateLimited);
    expect(
      toRouterError(504, new Headers({ [ERROR_TYPE_HEADER]: "deadline_exceeded" }), null),
    ).toBeInstanceOf(DeadlineExceeded);
  });

  it("leaves requestId null when the response carried no id", () => {
    expect(toRouterError(500, new Headers(), null).requestId).toBeNull();
  });

  it("survives a body that is not an object at all", () => {
    for (const body of [null, undefined, "plain text", 42, ["a"]]) {
      const err = toRouterError(502, new Headers({ [ERROR_TYPE_HEADER]: "provider_error" }), body);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.message).toBe("HTTP 502");
    }
  });
});

describe("an error_type from a newer server", () => {
  // SDKs are pinned by users while the server moves. An unrecognized bucket
  // must degrade to the base class rather than throw something untyped —
  // "treat an unknown value as internal_error" is advice for the caller, not
  // licence for the SDK to rewrite what the server actually said.
  it.each(["file_download_error", "cancelled", "queue_timeout", "something_invented_next_year"])(
    "produces the base RouterError carrying %s verbatim",
    (unknownType) => {
      const err = toRouterError(
        500,
        new Headers({ [ERROR_TYPE_HEADER]: unknownType, [REQUEST_ID_HEADER]: "req-9" }),
        { detail: "a bucket this release has never heard of", error_type: unknownType },
      );

      expect(err).toBeInstanceOf(RouterError);
      expect(err.constructor).toBe(RouterError);
      expect(err.errorType).toBe(unknownType);
      expect(err.requestId).toBe("req-9");
      expect(err.message).toBe("a bucket this release has never heard of");
    },
  );

  it.each(["constructor", "toString", "__proto__", "hasOwnProperty"])(
    "does not resolve %s off Object.prototype",
    (inherited) => {
      // A bucket→class table is an object, and an object answers for every key
      // on Object.prototype. Resolving one would hand back something that is
      // not a RouterError — an untyped throw by another route.
      const err = toRouterError(500, new Headers({ [ERROR_TYPE_HEADER]: inherited }), {
        detail: "hostile bucket",
      });
      expect(err).toBeInstanceOf(RouterError);
      expect(err.constructor).toBe(RouterError);
      expect(err.errorType).toBe(inherited);
      expect(err.message).toBe("hostile bucket");
    },
  );

  it("is catchable as a RouterError", async () => {
    const response = stubErrorResponse(
      500,
      { detail: "nope", error_type: "queue_timeout" },
      { [ERROR_TYPE_HEADER]: "queue_timeout" },
    );
    await expect(raise(response)).rejects.toBeInstanceOf(RouterError);
  });
});

describe("InvalidInput and the 422 detail[] shape", () => {
  const validationBody = {
    detail: [
      {
        loc: ["body", "image_url"],
        msg: "Image is smaller than the minimum supported size",
        type: "image_too_small",
        ctx: { min_width: 512, min_height: 512 },
        input: "https://example.com/tiny.png",
      },
      {
        loc: ["body", "images", 0],
        msg: "Input should be greater than 8",
        type: "greater_than",
        ctx: { limit_value: 8 },
      },
      { loc: ["body", "prompt"], msg: "Field required", type: "missing" },
    ],
  };

  function raise422(): InvalidInput {
    const err = toRouterError(
      422,
      new Headers({ [ERROR_TYPE_HEADER]: "invalid_input", [REQUEST_ID_HEADER]: "req-422" }),
      validationBody,
    );
    expect(err).toBeInstanceOf(InvalidInput);
    return err as InvalidInput;
  }

  it("exposes every entry as structured data, not a flattened string", () => {
    const err = raise422();
    expect(err.detail).toHaveLength(3);

    const [first, second, third] = err.detail;
    expect(first.loc).toEqual(["body", "image_url"]);
    expect(first.msg).toBe("Image is smaller than the minimum supported size");
    expect(first.type).toBe("image_too_small");
    expect(first.ctx).toEqual({ min_width: 512, min_height: 512 });
    expect(first.input).toBe("https://example.com/tiny.png");

    // An integer segment indexes into an array and must stay a number.
    expect(second.loc).toEqual(["body", "images", 0]);
    expect(second.ctx).toEqual({ limit_value: 8 });

    // ctx and input are absent when the provider carried neither.
    expect(third.type).toBe("missing");
    expect(third.ctx).toBeUndefined();
    expect("input" in third).toBe(false);
  });

  it("keeps the provider's specific type, which the coarse bucket cannot express", () => {
    const err = raise422();
    expect(err.errorType).toBe("invalid_input");
    expect(err.detail.map((d) => d.type)).toEqual(["image_too_small", "greater_than", "missing"]);
  });

  it("summarizes the first failure into the message, and says how many more", () => {
    expect(raise422().message).toBe(
      "body.image_url: Image is smaller than the minimum supported size (and 2 more validation errors)",
    );
    const single = toRouterError(422, new Headers({ [ERROR_TYPE_HEADER]: "invalid_input" }), {
      detail: [{ loc: ["body"], msg: "Field required", type: "missing" }],
    });
    expect(single.message).toBe("body: Field required");

    // Two entries: the count is singular, and an empty `loc` names no field.
    const pair = toRouterError(422, new Headers({ [ERROR_TYPE_HEADER]: "invalid_input" }), {
      detail: [
        { loc: [], msg: "Could not parse the request", type: "value_error" },
        { loc: ["body"], msg: "Field required", type: "missing" },
      ],
    });
    expect(pair.message).toBe("request: Could not parse the request (and 1 more validation error)");
  });

  it("carries requestId like every other Router error", () => {
    expect(raise422().requestId).toBe("req-422");
    expect(raise422().httpStatus).toBe(422);
  });

  it("is catchable both as InvalidInput and as RouterError", async () => {
    const response = stubErrorResponse(422, validationBody, {
      [ERROR_TYPE_HEADER]: "invalid_input",
    });
    await expect(raise(response)).rejects.toBeInstanceOf(InvalidInput);

    const again = stubErrorResponse(422, validationBody, { [ERROR_TYPE_HEADER]: "invalid_input" });
    await expect(raise(again)).rejects.toBeInstanceOf(RouterError);
  });

  it("gives an empty detail[] for a request-level invalid_input, keeping the prose", () => {
    // Router rejects some requests before dispatch; that failure names no
    // field and arrives with the string-bodied shape.
    const err = toRouterError(400, new Headers({ [ERROR_TYPE_HEADER]: "invalid_input" }), {
      detail: "The request was rejected as invalid for this model.",
      error_type: "invalid_input",
    });
    expect(err).toBeInstanceOf(InvalidInput);
    expect((err as InvalidInput).detail).toEqual([]);
    expect(err.message).toBe("The request was rejected as invalid for this model.");
  });

  it("drops a malformed entry rather than half-materializing it", () => {
    const err = toRouterError(422, new Headers({ [ERROR_TYPE_HEADER]: "invalid_input" }), {
      detail: [
        { loc: ["body"], msg: "ok", type: "missing" },
        { loc: ["body"], msg: "no type" },
        { msg: "no loc", type: "missing" },
        { loc: ["body", { nested: true }], msg: "bad loc segment", type: "missing" },
        "not an object",
        null,
      ],
    });
    expect((err as InvalidInput).detail).toEqual([
      { loc: ["body"], msg: "ok", type: "missing" },
    ] satisfies ValidationErrorDetail[]);
  });

  it("degrades to an empty detail[] when the 422 body is unusable", () => {
    const err = toRouterError(422, new Headers({ [ERROR_TYPE_HEADER]: "invalid_input" }), null);
    expect(err).toBeInstanceOf(InvalidInput);
    expect((err as InvalidInput).detail).toEqual([]);
    expect(err.message).toBe("The request was rejected as invalid for this model.");
  });
});
