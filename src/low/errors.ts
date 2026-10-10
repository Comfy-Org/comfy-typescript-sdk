/**
 * The shared error envelope mapped to a typed exception per `code`.
 *
 * This is the `low` (protocol) view of errors: one class per documented error
 * `code`, plus a fallback. The `sdk` layer re-raises these as its own
 * idiomatic exceptions where it adds value (e.g. `JobFailed` carrying node
 * details), but the protocol codes are defined here so the generated layer
 * has a stable, typed error surface. Mirrors `comfy_low.errors` in the
 * Python SDK.
 */

export interface ApiErrorOptions {
  code?: string;
  httpStatus: number;
  details?: Record<string, unknown> | null;
  retryAfter?: number | null;
  /** See {@link ApiError.organizationId}. */
  organizationId?: string | null;
}

export class ApiError extends Error {
  static readonly code: string = "error";

  readonly code: string;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | null;
  readonly retryAfter: number | null;
  /**
   * On `sso_required`: the organization whose single sign-on governs this key
   * — the `organization` query parameter of Comfy Cloud's SSO start. `null` on
   * every other code and when the server does not know it.
   */
  readonly organizationId: string | null;

  constructor(message: string, options: ApiErrorOptions) {
    super(message);
    this.name = new.target.name;
    this.code = options.code ?? (new.target as typeof ApiError).code;
    this.httpStatus = options.httpStatus;
    this.details = options.details ?? null;
    this.retryAfter = options.retryAfter ?? null;
    this.organizationId = options.organizationId ?? null;
  }
}

export class InvalidWorkflow extends ApiError {
  static override readonly code = "invalid_workflow";
}

export class WorkflowFormatUi extends ApiError {
  static override readonly code = "workflow_format_ui";
}

export class MissingAsset extends ApiError {
  static override readonly code = "missing_asset";
}

export class HashMismatch extends ApiError {
  static override readonly code = "hash_mismatch";
}

export class BlobNotFound extends ApiError {
  static override readonly code = "blob_not_found";
}

export class IdempotencyKeyReuse extends ApiError {
  static override readonly code = "idempotency_key_reuse";
}

export class QueueFull extends ApiError {
  static override readonly code = "queue_full";
}

export class InsufficientCredits extends ApiError {
  static override readonly code = "insufficient_credits";
}

export class NotFound extends ApiError {
  static override readonly code = "not_found";
}

export class Unauthorized extends ApiError {
  static override readonly code = "unauthorized";
}

export class Forbidden extends ApiError {
  static override readonly code = "forbidden";
}

type ApiErrorClass = new (message: string, options: ApiErrorOptions) => ApiError;

const BY_CODE: Record<string, ApiErrorClass> = {
  invalid_workflow: InvalidWorkflow,
  workflow_format_ui: WorkflowFormatUi,
  missing_asset: MissingAsset,
  hash_mismatch: HashMismatch,
  blob_not_found: BlobNotFound,
  idempotency_key_reuse: IdempotencyKeyReuse,
  queue_full: QueueFull,
  insufficient_credits: InsufficientCredits,
  not_found: NotFound,
  // public-api currently returns entity-specific 404 codes even though the spec
  // documents the generic `not_found`; map them so callers still get a typed
  // NotFound. (Server/spec reconciliation is a separate follow-up.)
  job_not_found: NotFound,
  asset_not_found: NotFound,
  unauthorized: Unauthorized,
  forbidden: Forbidden,
  // The key is valid but the account must sign in through its organization's
  // SSO; a Forbidden so an auth `catch` sees it, `code` stays `sso_required`,
  // `organizationId` names the org.
  sso_required: Forbidden,
};

const CODE_BY_STATUS: Record<number, string> = {
  401: "unauthorized",
  402: "insufficient_credits",
  403: "forbidden",
  404: "not_found",
  409: "hash_mismatch",
  422: "invalid_workflow",
  429: "queue_full",
};

interface ErrorEnvelopeBody {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown> | null;
    /** Present only on `sso_required`. */
    organization_id?: string;
  };
}

/**
 * Build the typed exception for an error response. Falls back to a
 * status-derived code when the body is missing or not a well-formed
 * envelope, so a bare 401 with no JSON still maps to `Unauthorized`.
 */
export function errorFromEnvelope(
  httpStatus: number,
  body: ErrorEnvelopeBody | null | undefined,
  options: { retryAfter?: number | null } = {},
): ApiError {
  const err = body && typeof body === "object" ? body.error : undefined;
  let code = err && typeof err === "object" ? err.code : undefined;
  let message = err && typeof err === "object" ? err.message : undefined;
  const details = err && typeof err === "object" ? err.details : undefined;
  const rawOrganizationId = err && typeof err === "object" ? err.organization_id : undefined;

  if (!code) {
    code = CODE_BY_STATUS[httpStatus] ?? "error";
  }
  if (!message) {
    message = `HTTP ${httpStatus}`;
  }
  // Read only on `sso_required`, so a gateway that stamps org context into
  // every error body cannot make an unrelated failure look like an SSO prompt.
  const organizationId =
    code === "sso_required" &&
    typeof rawOrganizationId === "string" &&
    rawOrganizationId.trim() !== ""
      ? rawOrganizationId
      : null;

  // `Object.hasOwn`, so a wire code like `constructor` falls back to ApiError
  // instead of resolving an `Object.prototype` member.
  const cls = Object.hasOwn(BY_CODE, code) ? BY_CODE[code] : ApiError;
  return new cls(message, {
    code,
    httpStatus,
    details: details && typeof details === "object" ? details : null,
    retryAfter: options.retryAfter ?? null,
    organizationId,
  });
}
