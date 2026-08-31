import { request } from "./http.js"

const ONTOLOGY_PATH = "ontology/query"

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
 * Access is governed: the query runs as the deployment's agent instance and
 * returns only the subset of the ontology that the agent's permission groups
 * grant. Every query targets a named data schema, passed as `dataSchema`.
 *
 * During development, discover the data schemas available to the school with the
 * `list_ontology_data_schemas` MCP tool, and inspect a schema's tables and
 * columns with `describe_ontology_effective_schema`. Build the SQL against that
 * governed schema: a table or column outside what the agent's permissions grant
 * is not queryable and comes back as `ontology_forbidden`.
 *
 * @param query - The data schema, SQL, and optional row cap.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `ontology_sql_error` (400, malformed or rejected SQL),
 * `ontology_forbidden` (403, the query asked for data the agent's permissions do
 * not cover; `body.details.code` carries the upstream reason code),
 * `ontology_not_configured` (422, the deployment has no agent instance or the
 * school has no ontology set up), `ontology_provisioning` (409, the school's
 * ontology views are still being built), `ontology_timeout` (504),
 * `ontology_unavailable` (500, the ontology service could not be reached).
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
