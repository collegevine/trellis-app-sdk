import { AUTH_MODE_AUTHENTICATED, readAuthMode } from "./env.js"
import { TrellisAppApiError, request } from "./http.js"

const ONTOLOGY_PATH = "ontology/query"
const ACTIONS_EXECUTE_PATH = "actions/execute"

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

/** A published Action, identified within an ontology data schema. */
export interface ActionReference {
  dataSchema: string
  key: string
}

/** A related entity passed to an Action by one of its resource names. */
export interface ActionResourceRef {
  type: string
  id: string | number
}

/** Inputs to a published Action. Parameter and resource names are Action-specific. */
export interface ActionArguments {
  subject: string | number
  params?: Record<string, unknown>
  resources?: Record<string, ActionResourceRef>
  /** ISO 8601 instant. Omit or pass `null` to use the request time. */
  asOf?: string | null
  /** Stable key to reuse when retrying an ambiguous submission. */
  idempotencyKey?: string | null
  rationale?: string | null
}

/** Arguments to {@link executeAction}. */
export interface ExecuteActionRequest {
  action: ActionReference
  arguments: ActionArguments
  /** Required for a staff token; a constituent token supplies its own identity. */
  constituentId?: number
}

/**
 * An invocation receipt. A successful HTTP response does not mean the effect
 * completed or succeeded; inspect `complete`, `succeeded`, and `guarantee`.
 * Receipt field names match the Rails response.
 */
export interface ActionReceipt {
  invocation: string
  action: string
  rev: number
  state: string
  complete_at: string
  complete: boolean
  succeeded: boolean
  waiting_on?: string | null
  deduped: boolean
  guarantee: string
}

/**
 * Submit a published ontology Action as the signed-in App user. Server-only.
 * The deployment must use authenticated mode; this endpoint cannot be called
 * with an anonymous App deployment secret. Rails derives the school and App
 * from the user's access token. Staff callers must provide `constituentId`.
 *
 * A 200 response is an invocation receipt, including for pending or failed
 * effects. The SDK does not retry submissions automatically. Reuse the same
 * `idempotencyKey` if a submission's outcome is uncertain.
 *
 * @throws {@link TrellisAppApiError} for HTTP errors. Inspect `status` and
 * `body`; a 504 timeout may have submitted the effect, so retry with the same
 * idempotency key.
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
 * if (receipt.complete && receipt.succeeded) {
 *   // The effect succeeded.
 * }
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
        ...(asOf === undefined ? {} : { as_of: asOf }),
        ...(idempotencyKey === undefined
          ? {}
          : { idempotency_key: idempotencyKey }),
        ...(rationale === undefined ? {} : { rationale })
      },
      ...(constituentId === undefined ? {} : { constituent_id: constituentId })
    }
  })
}
