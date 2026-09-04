import OpenAI from "openai";
import {
  Agent as UndiciAgent,
  FormData as UndiciFormData,
  fetch as undiciFetch,
} from "undici";

const DEFAULT_OPENAI_TIMEOUT_MS = 20 * 60 * 1000;

function requestTimeoutMs() {
  const configured = Number(process.env.OPENAI_TIMEOUT_MS ?? DEFAULT_OPENAI_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    throw new Error("OPENAI_TIMEOUT_MS must be a positive number of milliseconds.");
  }
  return configured;
}

let client: OpenAI | undefined;

export function copyFormDataForUndici(source: FormData) {
  const copy = new UndiciFormData();
  for (const [name, value] of source.entries()) {
    if (typeof value === "string") {
      copy.append(name, value);
    } else {
      copy.append(name, value, value.name);
    }
  }
  return copy;
}

export const undiciFetchWithUploadSupport = Object.assign(
  async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
    const body = init?.body;
    const compatibleInit = body instanceof FormData
      ? { ...init, body: copyFormDataForUndici(body) }
      : init;
    return undiciFetch(
      input as Parameters<typeof undiciFetch>[0],
      compatibleInit as Parameters<typeof undiciFetch>[1],
    ) as unknown as Response;
  },
  // The SDK uses this constructor to verify that the supplied fetch can encode
  // the application's global FormData implementation.
  { Response: globalThis.Response },
) as typeof globalThis.fetch;

export function getOpenAIClient() {
  if (client) return client;

  const timeout = requestTimeoutMs();
  const dispatcher = new UndiciAgent({
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });

  client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout,
    maxRetries: 0,
    fetch: undiciFetchWithUploadSupport,
    fetchOptions: { dispatcher },
  });

  return client;
}

export function getOpenAIRequestTimeoutMs() {
  return requestTimeoutMs();
}
