import { request } from "./http.js"

const LLM_PATH = "llm"

/** Role of an {@link LlmMessage} in a conversation. */
export type LlmRole = "system" | "user" | "assistant"

/** A single message in the conversation passed to {@link runLlmInference}. */
export interface LlmMessage {
  role: LlmRole
  content: string
}

/** Result of {@link runLlmInference}: the model's completion text. */
export interface LlmInferenceResult {
  text: string
}

/**
 * Run a single LLM inference and return the completion text. Server-only.
 *
 * The model is chosen server-side; the app cannot pick it. Calls are stateless,
 * so to continue a conversation resend the full prior `messages` array plus the
 * new turn. Email addresses and phone numbers in `user` messages are redacted
 * before the model sees them. Usage is metered to the school that owns the
 * deployment.
 *
 * To send images or PDFs, upload them first with {@link uploadFile} and pass the
 * returned ids as `uploadIds`.
 *
 * @param messages - The conversation. Each `content` must be a non-empty string.
 * @param uploadIds - Ids returned by {@link uploadFile} for multimodal input.
 * @throws {@link TrellisAppApiError} whose `body.error` is one of:
 * `invalid_messages` (400, empty or malformed `messages`),
 * `input_too_large` (400, combined content over the cap),
 * `llm_rate_limited` (429, provider rate limit), `llm_error` (500).
 *
 * @example
 * ```ts
 * const { text } = await runLlmInference([
 *   { role: "system", content: "You summarize text in one sentence." },
 *   { role: "user", content: "..." }
 * ])
 * ```
 */
export async function runLlmInference(
  messages: LlmMessage[],
  uploadIds: string[] = []
): Promise<LlmInferenceResult> {
  return request<LlmInferenceResult>(LLM_PATH, {
    method: "POST",
    body: { messages, upload_ids: uploadIds }
  })
}
