import { request } from "./http.js"

const LLM_PATH = "llm"

export type LlmRole = "system" | "user" | "assistant"

export interface LlmMessage {
  role: LlmRole
  content: string
}

export interface LlmInferenceResult {
  text: string
}

// Runs a single LLM inference. The model and all billing scope are
// chosen server-side from the deployment; the app supplies only the
// conversation and gets back the completion text.
export async function runLlmInference(
  messages: LlmMessage[]
): Promise<LlmInferenceResult> {
  return request<LlmInferenceResult>(LLM_PATH, {
    method: "POST",
    body: { messages }
  })
}
