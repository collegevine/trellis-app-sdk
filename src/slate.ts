import { request } from "./http.js"

const SLATE_PATH = "slate"

// Rows come back as arrays in `columns` order (denser on the wire than
// per-row objects). Default to `unknown[]`; callers with known column
// shapes can supply a tuple type, e.g. `querySlate<[string, number]>`.
export interface SlateQueryResult<TRow = unknown[]> {
  columns: string[]
  rows: TRow[]
}

export async function querySlate<TRow = unknown[]>(
  query: string
): Promise<SlateQueryResult<TRow>> {
  return request<SlateQueryResult<TRow>>(SLATE_PATH, {
    method: "POST",
    body: { query }
  })
}
