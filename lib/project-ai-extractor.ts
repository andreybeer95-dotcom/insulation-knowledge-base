type ProjectAiProvider = "anthropic" | "openrouter" | "openai";

export type ProjectAiLayer = {
  role?: string | null;
  material?: string | null;
  thicknessMm?: number | null;
  areaM2?: number | null;
  layerCount?: number | null;
  quantity?: number | null;
  unit?: string | null;
  quantityType?: "m2" | "m3" | "шт" | "project" | null;
  projectOnly?: boolean | null;
  confidence?: "high" | "medium" | "low" | "none" | null;
  sourceText?: string | null;
  note?: string | null;
};

export type ProjectAiExtraction =
  | {
      status: "disabled" | "skipped" | "failed";
      reason: string;
      provider?: ProjectAiProvider;
      model?: string;
    }
  | {
      status: "ok";
      provider: ProjectAiProvider;
      model: string;
      roofAreaM2: number | null;
      roofAreaSource: string | null;
      roofAreaConfidence: "high" | "medium" | "low" | "none";
      layers: ProjectAiLayer[];
      warnings: string[];
    };

type ExtractRoofProjectInput = {
  text: string;
  question: string;
  direction: string;
  shouldRun: boolean;
};

function getProvider(): ProjectAiProvider | null {
  const configured = process.env.PROJECT_AI_PROVIDER?.trim().toLowerCase();
  if (configured === "anthropic" || configured === "openrouter" || configured === "openai") {
    return configured;
  }
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return null;
}

function getModel(provider: ProjectAiProvider) {
  if (process.env.PROJECT_AI_MODEL) return process.env.PROJECT_AI_MODEL;
  if (provider === "anthropic") return "claude-3-5-haiku-20241022";
  if (provider === "openrouter") return "openai/gpt-4o-mini";
  return "gpt-4o-mini";
}

function getApiKey(provider: ProjectAiProvider) {
  if (provider === "anthropic") return process.env.ANTHROPIC_API_KEY ?? null;
  if (provider === "openrouter") return process.env.OPENROUTER_API_KEY ?? null;
  return process.env.OPENAI_API_KEY ?? null;
}

export function getProjectAiExtractorMode() {
  const mode = process.env.PROJECT_AI_EXTRACTOR_MODE?.trim().toLowerCase();
  if (mode === "off" || mode === "always" || mode === "fallback") return mode;
  return "fallback";
}

export function hasProjectAiExtractorConfig() {
  const provider = getProvider();
  return provider !== null && getApiKey(provider) !== null;
}

function compactSnippet(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function collectWindows(text: string, patterns: RegExp[], radius = 2200) {
  const windows: Array<{ start: number; end: number }> = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      const start = Math.max(0, index - radius);
      const end = Math.min(text.length, index + radius);
      if (!windows.some((window) => start >= window.start && end <= window.end)) {
        windows.push({ start, end });
      }
    }
  }

  return windows
    .sort((a, b) => a.start - b.start)
    .reduce<Array<{ start: number; end: number }>>((merged, window) => {
      const last = merged[merged.length - 1];
      if (!last || window.start > last.end + 300) {
        merged.push({ ...window });
      } else {
        last.end = Math.max(last.end, window.end);
      }
      return merged;
    }, []);
}

function selectRoofExtractionText(text: string) {
  const patterns = [
    /площадь\s+(?:кровли|покрытия|застройки)/gi,
    /спецификац[а-я\s-]*(?:кров|покрыт|ворон)/gi,
    /состав\s+кровл/gi,
    /тип\s+кровл/gi,
    /logicroof|ecoplast|пвх[а-я\s-]*мембран/gi,
    /техноэласт|унифлекс|бикрост|линокром/gi,
    /logicpir|техноруф|carbon|xps|эппс/gi,
    /пароизоляц|технобарьер|паробарьер/gi,
    /воронк|водосток|водоотвод|желоб/gi,
    /сэндвич-панел|сендвич-панел/gi,
  ];

  const windows = collectWindows(text, patterns);
  if (!windows.length) return text.slice(0, 18000);

  let result = "";
  for (const window of windows) {
    const next = compactSnippet(text.slice(window.start, window.end));
    if (result.length + next.length > 26000) break;
    result += `${result ? "\n\n---\n\n" : ""}${next}`;
  }
  return result || text.slice(0, 18000);
}

function buildPrompt(input: ExtractRoofProjectInput) {
  const extractionText = selectRoofExtractionText(input.text);
  return [
    "Ты извлекаешь факты из PDF строительного проекта для предварительного расчета материалов.",
    "Верни ТОЛЬКО JSON без Markdown.",
    "Не подбирай и не выдумывай коды 1С. Не добавляй материалы, которых нет в тексте.",
    "Если площадь/толщина/количество не указаны явно, ставь null и confidence low/none.",
    "Для кровли отдельно выделяй разные типы кровли, слои пирога, площади, толщины, воронки и водосток.",
    "LOGICPIR SLOPE и уклоны помечай projectOnly=true, если нет раскладки элементов.",
    "Сэндвич-панели, профлист и конструктивное основание помечай projectOnly=true.",
    "JSON schema:",
    `{"roofAreaM2":number|null,"roofAreaSource":string|null,"roofAreaConfidence":"high|medium|low|none","layers":[{"role":string,"material":string,"thicknessMm":number|null,"areaM2":number|null,"layerCount":number|null,"quantity":number|null,"unit":string|null,"quantityType":"m2|m3|шт|project","projectOnly":boolean,"confidence":"high|medium|low|none","sourceText":string|null,"note":string|null}],"warnings":[string]}`,
    "",
    `Направление: ${input.direction || "кровля"}`,
    `Задача менеджера: ${input.question || "Посчитать материалы по проекту"}`,
    "",
    "Фрагменты PDF:",
    extractionText,
  ].join("\n");
}

function extractJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced ?? text;
  const first = source.indexOf("{");
  const last = source.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return source.slice(first, last + 1);
}

function normalizeNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(",", "."));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" | "none" {
  return value === "high" || value === "medium" || value === "low" || value === "none" ? value : "low";
}

function normalizeQuantityType(value: unknown): ProjectAiLayer["quantityType"] {
  return value === "m2" || value === "m3" || value === "шт" || value === "project" ? value : null;
}

function normalizeExtraction(raw: unknown, provider: ProjectAiProvider, model: string): ProjectAiExtraction {
  const data = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const rawLayers = Array.isArray(data.layers) ? data.layers : [];
  const layers = rawLayers
    .filter((layer): layer is Record<string, unknown> => Boolean(layer) && typeof layer === "object")
    .map((layer) => ({
      role: typeof layer.role === "string" ? layer.role : null,
      material: typeof layer.material === "string" ? layer.material : null,
      thicknessMm: normalizeNumber(layer.thicknessMm),
      areaM2: normalizeNumber(layer.areaM2),
      layerCount: normalizeNumber(layer.layerCount),
      quantity: normalizeNumber(layer.quantity),
      unit: typeof layer.unit === "string" ? layer.unit : null,
      quantityType: normalizeQuantityType(layer.quantityType),
      projectOnly: typeof layer.projectOnly === "boolean" ? layer.projectOnly : null,
      confidence: normalizeConfidence(layer.confidence),
      sourceText: typeof layer.sourceText === "string" ? layer.sourceText.slice(0, 300) : null,
      note: typeof layer.note === "string" ? layer.note : null,
    }))
    .filter((layer) => layer.material || layer.role);

  return {
    status: "ok",
    provider,
    model,
    roofAreaM2: normalizeNumber(data.roofAreaM2),
    roofAreaSource: typeof data.roofAreaSource === "string" ? data.roofAreaSource : null,
    roofAreaConfidence: normalizeConfidence(data.roofAreaConfidence),
    layers,
    warnings: Array.isArray(data.warnings) ? data.warnings.filter((item): item is string => typeof item === "string") : [],
  };
}

async function callAnthropic(prompt: string, apiKey: string, model: string) {
  const timeoutMs = Number(process.env.PROJECT_AI_TIMEOUT_MS ?? 35000);
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1800,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) throw new Error(`Anthropic extraction failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  return data.content?.find((item) => item.type === "text")?.text ?? "";
}

async function callOpenAiCompatible(prompt: string, apiKey: string, model: string, provider: "openai" | "openrouter") {
  const timeoutMs = Number(process.env.PROJECT_AI_TIMEOUT_MS ?? 35000);
  const url = provider === "openrouter"
    ? "https://openrouter.ai/api/v1/chat/completions"
    : "https://api.openai.com/v1/chat/completions";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (provider === "openrouter") {
    headers["HTTP-Referer"] = process.env.NEXT_PUBLIC_SITE_URL ?? "https://insulation-knowledge-base-production.up.railway.app";
    headers["X-Title"] = "TSTN Project Extractor";
  }

  const response = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers,
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: "Ты извлекаешь структурированные факты из строительных PDF. Отвечай только JSON." },
        { role: "user", content: prompt },
      ],
    }),
  });

  if (!response.ok) throw new Error(`${provider} extraction failed: ${response.status} ${await response.text()}`);
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? "";
}

export async function extractRoofProjectWithAi(input: ExtractRoofProjectInput): Promise<ProjectAiExtraction> {
  const provider = getProvider();
  if (!provider) return { status: "disabled", reason: "AI extractor provider/key is not configured" };

  const apiKey = getApiKey(provider);
  const model = getModel(provider);
  if (!apiKey) return { status: "disabled", reason: "AI extractor API key is not configured", provider, model };
  if (!input.shouldRun) return { status: "skipped", reason: "Baseline parser confidence is enough", provider, model };

  try {
    const prompt = buildPrompt(input);
    const content = provider === "anthropic"
      ? await callAnthropic(prompt, apiKey, model)
      : await callOpenAiCompatible(prompt, apiKey, model, provider);
    const json = extractJsonObject(content);
    if (!json) throw new Error("AI extractor returned no JSON object");
    return normalizeExtraction(JSON.parse(json), provider, model);
  } catch (error) {
    return {
      status: "failed",
      provider,
      model,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
