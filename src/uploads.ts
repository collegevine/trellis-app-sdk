import { requestRaw } from "./http.js"

const UPLOADS_PATH = "uploads"

export interface UploadResult {
  upload_id: string
}

// Uploads a single file for use as multimodal LLM input. Returns an opaque
// `upload_id` that can be passed to `runLlmInference`.
export async function uploadFile(
  data: Uint8Array,
  contentType: string,
  filename: string
): Promise<UploadResult> {
  const path = `${UPLOADS_PATH}?filename=${encodeURIComponent(filename)}`
  return requestRaw<UploadResult>(path, data, contentType)
}
