import { AUTH_MODE_AUTHENTICATED, readAuthMode } from "./env.js"
import { TrellisAppApiError, request } from "./http.js"

const ONTOLOGY_PATH = "ontology/query"
const ACTIONS_EXECUTE_PATH = "actions/execute"
const FUNCTIONS_EVALUATE_PATH = "functions/evaluate"

/** A column in an {@link OntologyQueryResult}: its name and Databricks SQL type. */
export interface OntologyColumn {
  name: string
  type: string
}

/**
 * Result of an ontology query. `rows` come back as arrays in `columns` order;
 * every non-null cell is a string on the wire, whatever its SQL type. `truncated`
 * is true when the row cap (`maxRows`, or the service's own default) was reached,
 * so the caller can narrow the query or raise the cap.
 *
 * @typeParam TRow - The row tuple shape. Defaults to `(string | null)[]`; callers
 * with a known column shape can supply a tuple type, e.g.
 * `queryOntology<[string, string]>(...)`.
 */
export interface OntologyQueryResult<TRow = (string | null)[]> {
  columns: OntologyColumn[]
  rows: TRow[]
  truncated: boolean
}

/** Arguments to {@link queryOntology}. */
export interface OntologyQuery {
  /**
   * The named data schema to query, e.g. `"ontology_v2"` — selects which set of
   * governed views the query runs against. See {@link queryOntology} for how to
   * discover the schemas available to a school.
   */
  dataSchema: string
  /** The read-only SQL to run. */
  sql: string
  /**
   * Cap on the number of rows returned, overriding the service's default. When
   * the cap is reached the result's `truncated` flag is set. Must be a positive
   * integer when given; omit it to use the default cap.
   */
  maxRows?: number
}

/**
 * Run a read-only SQL query against the school's ontology. Server-only.
 *
 * Access is governed: a signed-in HQ or school user queries as themselves and
 * sees only what their own permission groups grant. An anonymous session, or
 * one signed in as a constituent, queries as the app itself, whose own
 * permission groups are the grant; a constituent's identity, when available, is
 * also passed to the query as a sidecar parameter, which may be used by
 * constituent-scoped data schemas to filter rows. Every query targets a named
 * data schema, passed as `dataSchema`.
 *
 * During development, discover the data schemas available to the school with
 * the `list_ontology_data_schemas` MCP tool, and inspect a schema's tables and
 * columns with `describe_ontology_effective_schema`. Build the SQL against that
 * governed schema: a table or column outside what the acting principal's
 * permissions grant is not queryable and comes back as `ontology_forbidden`.
 *
 * @param query - The data schema, SQL, and optional row cap.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `ontology_sql_error` (400, malformed or rejected SQL), `ontology_forbidden`
 * (403, the query asked for data the acting principal's permissions do not
 * cover; `body.details.code` carries the upstream reason code),
 * `ontology_not_configured` (422, the school has no ontology set up),
 * `ontology_provisioning` (409, the school's ontology views are still being
 * built), `ontology_timeout` (504), `ontology_unavailable` (500, the ontology
 * service could not be reached).
 *
 * @example
 * ```ts
 * const { columns, rows, truncated } = await queryOntology({
 *   dataSchema: "ontology_v2",
 *   sql: "SELECT id, name FROM core_person",
 *   maxRows: 500
 * })
 * ```
 */
export async function queryOntology<TRow = (string | null)[]>(
  query: OntologyQuery
): Promise<OntologyQueryResult<TRow>> {
  const { dataSchema, sql, maxRows } = query
  return request<OntologyQueryResult<TRow>>(ONTOLOGY_PATH, {
    method: "POST",
    body: {
      sql,
      data_schema: dataSchema,
      ...(maxRows === undefined ? {} : { max_rows: maxRows })
    }
  })
}

/** Identifies a published Action within a data schema. */
export interface ActionReference {
  dataSchema: string
  key: string
}

/** Type and ID of an entity supplied as a named Action resource. */
export interface ActionResourceRef {
  type: string
  id: string | number
}

/** Invocation inputs; `params` and `resources` use names defined by the Action. */
export interface ActionArguments {
  subject: string | number
  params?: Record<string, unknown>
  resources?: Record<string, ActionResourceRef>
  /** As-of instant, serialized as UTC ISO 8601. Omit or use `null` for request time. */
  asOf?: Date | null
  /** Reuse this key when retrying a submission whose outcome is unknown. */
  idempotencyKey?: string | null
  rationale?: string | null
}

/** Arguments to {@link executeAction}. */
export interface ExecuteActionRequest {
  action: ActionReference
  arguments: ActionArguments
  /** Required for staff tokens; constituent tokens identify the constituent. */
  constituentId?: number
}

/**
 * Receipt for an Action invocation. HTTP 200 does not imply completion or
 * success; check `complete`, `succeeded`, and `guarantee`.
 */
export interface ActionReceipt {
  invocation: string
  action: string
  rev: number
  state: string
  /** Action's completion criterion, such as `accepted` or `confirmed`. */
  complete_at: string
  complete: boolean
  succeeded: boolean
  waiting_on?: string | null
  deduped: boolean
  guarantee: string
}

/**
 * Submit a published ontology Action for the current App user. Server-only.
 * Requires an authenticated deployment and a signed-in session. Staff callers
 * must supply `constituentId`; constituent sessions identify the constituent.
 *
 * Returns a receipt even when the Action is pending or failed. The SDK does
 * not retry submissions. Reuse `idempotencyKey` after a timeout or lost
 * response because the submission may already have occurred.
 *
 * @throws {@link TrellisAppApiError} for API or authentication errors; inspect
 * `status` and `body`. Network failures pass through unchanged.
 *
 * @example
 * ```ts
 * import { randomUUID } from "node:crypto"
 * const submissionId = randomUUID()
 * const receipt = await executeAction({
 *   action: { dataSchema: "ontology_v1", key: "app_contract_post_note" },
 *   arguments: {
 *     subject: "person-id",
 *     params: { note: "Submitted by the app", submission: submissionId },
 *     idempotencyKey: submissionId
 *   },
 *   constituentId: 1
 * })
 * ```
 */
export async function executeAction(
  submission: ExecuteActionRequest
): Promise<ActionReceipt> {
  if (readAuthMode() !== AUTH_MODE_AUTHENTICATED) {
    throw new TrellisAppApiError(
      "Action execution requires an authenticated Trellis App session",
      401,
      {
        error: "unauthorized",
        message: "Action execution requires an authenticated Trellis App session"
      }
    )
  }

  const { action, arguments: args, constituentId } = submission
  const { subject, params, resources, asOf, idempotencyKey, rationale } = args
  return request<ActionReceipt>(ACTIONS_EXECUTE_PATH, {
    method: "POST",
    body: {
      action: { data_schema: action.dataSchema, key: action.key },
      arguments: {
        subject,
        ...(params === undefined ? {} : { params }),
        ...(resources === undefined ? {} : { resources }),
        ...(asOf === undefined
          ? {}
          : { as_of: asOf === null ? null : asOf.toISOString() }),
        ...(idempotencyKey === undefined
          ? {}
          : { idempotency_key: idempotencyKey }),
        ...(rationale === undefined ? {} : { rationale })
      },
      ...(constituentId === undefined ? {} : { constituent_id: constituentId })
    }
  })
}

/** Any JSON value. Used for hypothetical replacements, which are sent as JSON. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Identifies a published function within a data schema. */
export interface FunctionReference {
  dataSchema: string
  key: string
}

/** Evaluation inputs for {@link evaluateFunction}. */
export interface FunctionArguments {
  /** The function's subject entity key; independent of the Rails constituent ID. */
  subject: string | number
  /**
   * Replacement values keyed by the function's own argument names, not ontology
   * property names. An explicit `null` requires a nullable argument.
   */
  hypotheticals?: Record<string, JsonValue>
  /**
   * Instant fed to the function's evaluation-clock arguments; defaults to now.
   * It does not select historical data.
   */
  asOf?: Date | null
}

/** Arguments to {@link evaluateFunction}. */
export interface EvaluateFunctionRequest {
  function: FunctionReference
  arguments: FunctionArguments
  /** Required for staff tokens; constituent tokens identify the constituent. */
  constituentId?: number
}

/** Result of {@link evaluateFunction}. */
export interface FunctionEvaluation<TResult = unknown> {
  function: string
  /** Active revision used for this evaluation. */
  rev: number
  subject: string | number
  hypotheticals?: Record<string, JsonValue>
  result: TResult
}

/**
 * Evaluate a published ontology function for the current App user, optionally
 * replacing some of its arguments with hypothetical values. Server-only.
 * Requires an authenticated deployment and a signed-in session.
 *
 * Hypotheticals apply only to this evaluation and never update data, so a
 * failed call is safe to retry; a repeat may see newer data or a newly
 * activated revision.
 *
 * @typeParam TResult - The expected shape of `result`; not checked at runtime.
 * @throws {@link TrellisAppApiError}; inspect `status`, `body.error`, and
 * `body.details?.code` (e.g. `FUNCTION_HYPOTHETICALS_INVALID`,
 * `FUNCTION_APPROVAL_REQUIRED`, `SUBJECT_NOT_FOUND`).
 *
 * @example
 * ```ts
 * const { result } = await evaluateFunction<string>({
 *   function: { dataSchema: "ontology_v2", key: "person_label" },
 *   arguments: { subject: "p1", hypotheticals: { first: "Hypothetical" } },
 *   constituentId: 123
 * })
 * ```
 */
export async function evaluateFunction<TResult = unknown>(
  evaluation: EvaluateFunctionRequest
): Promise<FunctionEvaluation<TResult>> {
  if (readAuthMode() !== AUTH_MODE_AUTHENTICATED) {
    throw new TrellisAppApiError(
      "Function evaluation requires an authenticated Trellis App session",
      401,
      {
        error: "unauthorized",
        message: "Function evaluation requires an authenticated Trellis App session"
      }
    )
  }

  const { function: fn, arguments: args, constituentId } = evaluation
  const { subject, hypotheticals, asOf } = args
  const data = await request<FunctionEvaluation<TResult>>(
    FUNCTIONS_EVALUATE_PATH,
    {
      method: "POST",
      body: {
        function: { data_schema: fn.dataSchema, key: fn.key },
        arguments: {
          subject,
          ...(hypotheticals === undefined ? {} : { hypotheticals }),
          ...(asOf === undefined
            ? {}
            : { as_of: asOf === null ? null : asOf.toISOString() })
        },
        ...(constituentId === undefined ? {} : { constituent_id: constituentId })
      }
    }
  )

  if (typeof data !== "object" || data === null || !("result" in data)) {
    throw new TrellisAppApiError(
      "Trellis App API returned a function evaluation without a result",
      200,
      data
    )
  }
  return data
}
