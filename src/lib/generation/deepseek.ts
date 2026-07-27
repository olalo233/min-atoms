import type { GenerationProvider } from "@/lib/generation/provider";
import type { GenerationInput } from "@/lib/generation/types";
import {
  buildArtifactInstruction,
  GENERATION_SYSTEM_PROMPT,
} from "@/lib/generation/prompts/artifact";

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_RESPONSE_SIZE = 180_000;

type DeepSeekResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
};

function getDeepSeekConfiguration() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("provider_unavailable");
  }

  return {
    apiKey,
    model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL,
  };
}

async function requestArtifact(
  input: GenerationInput,
  repairCandidate?: unknown,
  repairDiagnostic?: string,
): Promise<unknown> {
  const { apiKey, model } = getDeepSeekConfiguration();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(DEEPSEEK_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: GENERATION_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: buildArtifactInstruction(
              input,
              repairCandidate,
              repairDiagnostic,
            ),
          },
        ],
        max_tokens: 8_000,
        temperature: 0.2,
        thinking: { type: "disabled" },
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`provider_http_${response.status}`);
    }
    if (body.length > MAX_PROVIDER_RESPONSE_SIZE) {
      throw new Error("provider_response_too_large");
    }

    let payload: DeepSeekResponse;
    try {
      payload = JSON.parse(body) as DeepSeekResponse;
    } catch {
      throw new Error("provider_invalid_response");
    }
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length > MAX_PROVIDER_RESPONSE_SIZE) {
      throw new Error("provider_invalid_response");
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new Error("provider_invalid_response");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("provider_")) {
      throw error;
    }
    throw new Error("provider_unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export const deepSeekProvider: GenerationProvider = {
  generate(input) {
    return requestArtifact(input);
  },
  repair(input, candidate, diagnostic) {
    return requestArtifact(input, candidate, diagnostic);
  },
};

export { DEFAULT_DEEPSEEK_MODEL };
