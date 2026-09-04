// Impala AI adapter.
//
// Background: BG3's "Match a natural-language ProjectBrief through
// real search" ticket accepts either a configured managed AI
// provider or a deterministic fallback that crosses the same
// validation + TalentSearchService boundary. This module is the
// real managed adapter behind the provider-neutral AiAdapter
// contract.
//
// The managed adapter calls the Highrise × Impala OpenAI-compatible
// gateway:
//
//   POST {IMPALA_BASE_URL}/chat/completions
//   Authorization: Bearer <IMPALA_API_KEY>
//   Model:        IMPALA_MODEL (qwen3.6-27b)
//
// SoundHub instructs the model to return only structured JSON that
// matches the BG3 Matchmaker criteria shape. The adapter parses the
// textual response, then validates it against
// `matchmakerCriteriaV1Schema`. Only validated provider-neutral
// output crosses the adapter boundary. The adapter never queries
// Prisma, never searches sellers, and never invents marketplace
// facts — it interprets the buyer's brief and nothing else.
//
// Per ticket #60 the deployed matchmaker must fall back to the
// deterministic adapter when the managed provider is unavailable,
// returns malformed JSON, or returns output that fails runtime
// validation. The adapter surfaces every managed failure as
// `AiUnavailableError` so the existing MatchmakerService fallback
// path picks up the deterministic adapter unchanged.

import {
  matchmakerCriteriaV1Schema,
  type AiInterpretBriefInputV1,
  type AiInterpretBriefOutputV1,
} from "@soundhub/types";
import { AiUnavailableError, type AiAdapter } from "./ai-adapter.js";
import { FetchHttpTransport, HttpTransportError, type HttpTransport } from "./http-transport.js";

// ---------- Provider configuration ----------

// A bounded, allow-listed view of the managed-provider env
// configuration. The factory builds this from the process env and
// passes it explicitly so tests can construct adapters without
// touching `process.env`. The API key never appears in this
// type's name or in any DTO.
export interface ImpalaAdapterConfig {
  /** Gateway base URL, e.g. https://ht.getimpala.ai/v1 */
  readonly baseUrl: string;
  /** Bearer token presented in the Authorization header. */
  readonly apiKey: string;
  /** Model identifier, e.g. qwen3.6-27b. */
  readonly model: string;
  /** Per-request timeout in milliseconds. Defaults to 8000. */
  readonly timeoutMs?: number;
  /** Optional override for the documented providerLabel. */
  readonly providerLabel?: string;
}

// ---------- Chat-completions payload shape (gateway-specific, never crosses the DTO) ----------

// OpenAI-compatible chat completion request shape. These types are
// intentionally IMPALA-SPECIFIC and live ONLY inside this module;
// the SoundHub domain never references them. SoundHub sees only
// `AiInterpretBriefInputV1` and `AiInterpretBriefOutputV1`.
interface ImpalaChatMessage {
  readonly role: "system" | "user";
  readonly content: string;
}

interface ImpalaChatRequest {
  readonly model: string;
  readonly messages: readonly ImpalaChatMessage[];
  readonly temperature: number;
  readonly max_tokens: number;
}

interface ImpalaChatChoice {
  readonly index: number;
  readonly message: {
    readonly role: "assistant";
    readonly content: string;
  };
  readonly finish_reason?: string;
}

interface ImpalaChatResponse {
  readonly id?: string;
  readonly model?: string;
  readonly choices: readonly ImpalaChatChoice[];
}

// ---------- Adapter ----------

export class ImpalaAiAdapter implements AiAdapter {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly providerLabel: string;
  private readonly transport: HttpTransport;

  constructor(config: ImpalaAdapterConfig, transport?: HttpTransport) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.timeoutMs = config.timeoutMs ?? 8000;
    this.providerLabel = config.providerLabel ?? "managed";
    this.transport = transport ?? new FetchHttpTransport();
  }

  /**
   * Interpret a natural-language brief into a candidate Matchmaker
   * criteria payload.
   *
   * Failure semantics:
   *   - Configuration errors (missing key, malformed URL) throw
   *     `AiUnavailableError` immediately so the fallback path
   *     activates without a network round-trip.
   *   - Network/timeout/upstream errors throw `AiUnavailableError`
   *     with a coarse-grained message; raw provider details
   *     (status codes, response body, headers) NEVER appear in the
   *     error or in any DTO.
   *   - Schema-invalid output throws `AiUnavailableError`; the
   *     application layer's validation step would also catch this
   *     case and fall back, but failing fast at the adapter
   *     boundary keeps the failure mode obvious.
   */
  async interpretBrief(input: AiInterpretBriefInputV1): Promise<AiInterpretBriefOutputV1> {
    if (!this.apiKey || this.apiKey.trim().length === 0) {
      throw new AiUnavailableError("Managed AI provider is not configured.");
    }
    if (!this.baseUrl || !/^https?:\/\//.test(this.baseUrl)) {
      throw new AiUnavailableError("Managed AI provider base URL is invalid.");
    }

    const requestBody: ImpalaChatRequest = {
      model: this.model,
      temperature: 0,
      // The model is instructed to return a compact JSON document.
      // 1024 tokens is generous for the Matchmaker criteria payload
      // and bounded against runaway completions.
      max_tokens: 1024,
      messages: [buildSystemMessage(input), buildUserMessage(input)],
    };

    let responseText: string;
    try {
      const response = await this.transport.send({
        url: `${this.baseUrl}/chat/completions`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
        },
        body: JSON.stringify(requestBody),
        timeoutMs: this.timeoutMs,
      });
      responseText = response.bodyText;
    } catch (err) {
      if (err instanceof HttpTransportError) {
        // Never echo provider-side internals (status, body). Coarse
        // message + the recorded kind is enough for diagnostics.
        throw new AiUnavailableError(
          err.kind === "timeout"
            ? "Managed AI provider timed out."
            : "Managed AI provider is unavailable.",
        );
      }
      throw new AiUnavailableError("Managed AI provider is unavailable.");
    }

    const parsedPayload = safeParseChatResponse(responseText);
    if (!parsedPayload) {
      throw new AiUnavailableError("Managed AI provider returned a malformed response payload.");
    }

    const assistantContent = extractAssistantContent(parsedPayload);
    if (assistantContent === null) {
      throw new AiUnavailableError("Managed AI provider returned no assistant content.");
    }

    const parsedCandidate = safeParseJson(assistantContent);
    if (parsedCandidate === undefined) {
      throw new AiUnavailableError("Managed AI provider returned content that is not valid JSON.");
    }

    // Validate via the existing BG3 runtime schema. If the model's
    // output does not match the strict criteria shape, surface an
    // unavailable error so the application layer's fallback path
    // activates. We never pass unvalidated output to
    // TalentSearchService.
    const validated = matchmakerCriteriaV1Schema.safeParse(parsedCandidate);
    if (!validated.success) {
      throw new AiUnavailableError(
        "Managed AI provider returned output that did not pass runtime validation.",
      );
    }

    return {
      provider: "managed",
      modelId: parsedPayload.model ?? this.model,
      // The application service re-parses the candidate through
      // matchmakerCriteriaV1Schema; the adapter hands back the
      // raw validated JSON so the schema is the single authority.
      candidate: validated.data as unknown as Record<string, unknown>,
    };
  }

  isConfigured(): boolean {
    return this.apiKey.trim().length > 0 && /^https?:\/\//.test(this.baseUrl);
  }

  getModelId(): string | null {
    return this.model;
  }

  /**
   * The documented provider label, exposed only for diagnostic /
   * factory selection. NEVER echoes the API key, the URL, or any
   * request header.
   */
  getProviderLabel(): string {
    return this.providerLabel;
  }
}

// ---------- System prompt ----------

// The system prompt locks the model into a strict
// "return-only-structured-json" behaviour. The model has no
// knowledge of SoundHub schema names beyond this prompt; the
// application boundary validates the response. The prompt
// deliberately enumerates the required hard-constraint axes so
// required constraints are never silently relaxed (GS 14).
const SYSTEM_PROMPT = [
  "You are the Matchmaker interpreter for the SoundHub Caribbean creative-services marketplace.",
  "",
  "You receive a buyer's natural-language creative brief plus the acting Workspace identifier.",
  "",
  "Your only job is to translate the brief into a structured JSON document describing search criteria.",
  "You must NEVER query any database, search any catalogue, invent any ServiceOffering, or perform marketplace ranking.",
  "You must NEVER relax or drop required constraints the buyer expressed (service mode, primary category, location).",
  "You must NEVER include prose, commentary, markdown, or code fences. Your entire reply MUST be a single JSON document.",
  "",
  "Output schema (top-level JSON object):",
  "{",
  '  "required": {',
  '    "primaryCategoryKeys"?: string[],         // canonical ServiceCategory keys the buyer named',
  '    "independentlyPurchasableServiceKeys"?: string[],',
  '    "serviceModes"?: ("Remote" | "InPerson" | "Hybrid")[],',
  '    "basedIn"?: { "city"?: string, "region"?: string, "countryCode": "<ISO-2>" },',
  '    "serviceArea"?: { "city"?: string, "region"?: string, "countryCode": "<ISO-2>" }',
  "  },",
  '  "preferred"?: {',
  '    "categoryKeys"?: string[],',
  '    "includedServiceKeys"?: string[],',
  '    "specialties"?: string[],',
  '    "genreTags"?: string[],',
  '    "caribbeanAffiliationCodes"?: ("AG" | "BB" | "BS" | "BZ" | "DM" | "DO" | "GD" | "GY" | "HT" | "JM" | "KN" | "LC" | "SR" | "TT" | "VC")[],',
  '    "basedIn"?: { "city"?: string, "region"?: string, "countryCode": "<ISO-2>" },',
  '    "serviceModes"?: ("Remote" | "InPerson" | "Hybrid")[]',
  "  },",
  '  "query"?: string,                          // normalised buyer search query, only when no hard axis applies',
  '  "nonSearchRequirements"?: { [key: string]: string }',
  "}",
  "",
  "Rules:",
  "- Always emit a `required` object. It is mandatory in the SoundHub schema; never omit it.",
  "- Populate `required` with the buyer's hard axes when the brief names them. If the buyer named no hard axis, emit `required` as `{}` and put the brief text in `query`.",
  "- Only include a field when the buyer's brief explicitly expressed that signal.",
  "- Do not invent sellers, prices, availability, verification, ratings, or sample rights.",
  "- Do not authorise, rank, or shortlist. Ranking is performed by SoundHub after you return.",
  "- Country codes are ISO 3166-1 alpha-2 uppercase. Caribbean affiliations are limited to the listed codes.",
].join("\n");

function buildSystemMessage(_input: AiInterpretBriefInputV1): ImpalaChatMessage {
  // The acting Workspace identifier is NOT included in the
  // system message; it is buyer-side context that must not
  // leak into the prompt as a free-form instruction. Only the
  // brief text reaches the model.
  void _input;
  return { role: "system", content: SYSTEM_PROMPT };
}

function buildUserMessage(input: AiInterpretBriefInputV1): ImpalaChatMessage {
  return {
    role: "user",
    content: JSON.stringify({
      actingWorkspaceId: input.actingWorkspaceId,
      briefText: input.briefText,
      // Buyer-supplied non-search requirements are forwarded
      // verbatim so the model can echo them into the
      // `nonSearchRequirements` block when present. The model is
      // not permitted to add new keys.
      buyerNonSearchRequirements: input.buyerNonSearchRequirements ?? {},
    }),
  };
}

// ---------- Response parsing ----------

function safeParseChatResponse(body: string): ImpalaChatResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  // JSON.parse can legally return null, a primitive, or a non-object
  // value (e.g. "null", "[]", "42"). Reading `.choices` on any of
  // those throws a TypeError that bypasses the fallback path; the
  // adapter must validate the envelope shape before any property
  // access so an unusable body translates into an unavailable
  // error rather than an unhandled crash.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return null;
  }
  // Provider responses may carry extra metadata we ignore
  // (id, created, usage, system_fingerprint, etc.). The chat
  // adapter extracts only the assistant message content; any
  // other shape variation returns null and triggers the fallback.
  return parsed as ImpalaChatResponse;
}

function extractAssistantContent(response: ImpalaChatResponse): string | null {
  const first = response.choices[0];
  if (!first) return null;
  const content = first.message?.content;
  if (typeof content !== "string") return null;
  return content;
}

function safeParseJson(text: string): Record<string, unknown> | undefined {
  // Strip a single pair of surrounding markdown code fences if the
  // model emits them despite the system prompt forbidding them.
  // Anything else is treated as malformed JSON.
  const trimmed = text.trim();
  const stripped = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")
    : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}
