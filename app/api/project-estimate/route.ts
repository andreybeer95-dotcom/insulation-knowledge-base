import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

import { getServiceSupabase } from "@/lib/server-supabase";
import {
  extractRoofProjectWithAi,
  getProjectAiExtractorMode,
  hasProjectAiExtractorConfig,
  type ProjectAiExtraction,
  type ProjectAiLayer,
} from "@/lib/project-ai-extractor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type NomenclatureItem = {
  code: string | null;
  name: string | null;
  brand: string | null;
};

type InvoiceItem = {
  role: string;
  material: string | null;
  requestedLayer: string;
  code: string | null;
  brand: string | null;
  calculation: string;
  note: string | null;
  alternatives: Array<{ code: string | null; name: string | null; brand: string | null }>;
};

type ReviewItem = {
  role: string;
  requestedLayer: string;
  searchTerms?: string[];
  calculation: string;
  note: string;
  code?: string | null;
  material?: string | null;
  brand?: string | null;
  alternatives?: Array<{ code: string | null; name: string | null; brand: string | null }>;
};

type SystemRuleContext = {
  id?: string | null;
  rule_name?: string | null;
  condition?: string | null;
  rule_text?: string | null;
  priority?: number | null;
  category?: string | null;
  is_prohibition?: boolean | null;
};

type ProjectSystemContext = {
  id: string;
  name: string;
  source: "pdf" | "inferred" | "nav_tn";
  confidence: "high" | "medium" | "low";
  reason: string;
  navAnalogId?: string | null;
  navAnalogName?: string | null;
  warning?: string | null;
  rules: SystemRuleContext[];
};

type QuoteItem = {
  no: number;
  code: string | null;
  material: string | null;
  unit: string;
  quantity: string;
  calculation: string;
  role: string;
  note: string | null;
};

type AnalogRecommendation = {
  role: string;
  projectMaterial: string;
  analogMaterial: string | null;
  code: string | null;
  brand: string | null;
  quantity: string;
  unit: string;
  calculation: string;
  note: string;
};

let localNomenclatureCache: NomenclatureItem[] | null = null;

type AreaInfo = {
  value: number | null;
  source: "manager_input" | "pdf_text" | "axes_estimate" | "roof_plan_estimate" | "not_found";
  confidence: "high" | "medium" | "low" | "none";
  note: string;
  dimensions?: {
    lengthM: number;
    widthM: number;
    perimeterM: number;
    source: "roof_plan_dimensions" | "axes_dimensions";
  };
};

type DetectedLayer = {
  key: string;
  role: string;
  label: string;
  detected: boolean;
  searchTerms: string[];
  factor?: number;
  thicknessMm?: number;
  quantityType: "m2" | "m3" | "project";
  projectOnly?: boolean;
  reviewOnly?: boolean;
  note?: string;
  unitCount?: number;
  areaOverride?: number;
  quantityOverride?: {
    value: number;
    unit: "m2" | "m3" | "шт";
    source: string;
  };
};

const NUMBER = String.raw`(\d+(?:[,.]\d+)?)`;

function normalizeText(text: string) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[№N]\s*0?8/gi, "№08")
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function toNumber(value: string) {
  return Number(value.replace(",", "."));
}

function toLooseNumber(value: string) {
  return Number(value.replace(/\s+/g, "").replace(",", "."));
}

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function looksLikeRoofPlan(text: string) {
  return /план\s+кровл|тн-кровля|tn-кровля|кровл[\s\S]{0,120}уклон|воронк[\s\S]{0,80}водосток/i.test(text);
}

function detectRoofPlanDimensionMetrics(text: string) {
  if (!looksLikeRoofPlan(text)) return null;

  const scanWindow = text.slice(0, Math.min(text.length, 3500));
  const dimensionsM = Array.from(scanWindow.matchAll(/\b(\d{2,3})\s?000\b/g))
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value >= 15 && value <= 300);

  const unique = Array.from(new Set(dimensionsM)).sort((a, b) => b - a);
  if (unique.length < 2) return null;

  const [first, second] = unique;
  const area = first * second;
  if (!Number.isFinite(area) || area < 100) return null;

  return {
    first,
    second,
    area: round(area, 2),
    perimeter: round((first + second) * 2, 2),
  };
}

function sumAreaMatches(text: string, pattern: RegExp) {
  return Array.from(text.matchAll(pattern)).reduce((sum, match) => {
    const value = match[1] ? toNumber(match[1]) : NaN;
    return Number.isFinite(value) ? sum + value : sum;
  }, 0);
}

function extractRoofSpecAreas(text: string) {
  const lower = text.toLowerCase();
  const membraneOnConcreteArea = sumAreaMatches(
    lower,
    /полимерная мембрана logicroof v-rp[\s\S]{0,500}?logicpir prof[\s\S]{0,120}?40\s*мм[\s\S]{0,500}?технобарьер[\s\S]{0,180}?монолитн[\s\S]{0,80}?(\d{1,6}[,.]\d{2})/gi
  );
  const membraneOnProfiledSheetArea = sumAreaMatches(
    lower,
    /полимерная мембрана logicroof v-rp[\s\S]{0,500}?logicpir prof[\s\S]{0,120}?70\s*мм[\s\S]{0,500}?техноруф н проф[\s\S]{0,120}?100\s*мм[\s\S]{0,300}?профнастил[\s\S]{0,80}?(\d{1,6}[,.]\d{2})/gi
  );
  const sandwichRoofArea = sumAreaMatches(
    lower,
    /трехслойные металлические кровельные сэндвич-панели[\s\S]{0,300}?t\s*=\s*100\s*мм[\s\S]{0,400}?(\d{1,6}[,.]\d{2})/gi
  );

  return {
    membraneOnConcreteArea: round(membraneOnConcreteArea, 2),
    membraneOnProfiledSheetArea: round(membraneOnProfiledSheetArea, 2),
    membraneTotalArea: round(membraneOnConcreteArea + membraneOnProfiledSheetArea, 2),
    sandwichRoofArea: round(sandwichRoofArea, 2),
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function detectRoofArea(text: string, manualArea: string | null): AreaInfo {
  const manual = manualArea ? toNumber(manualArea) : NaN;
  if (Number.isFinite(manual) && manual > 0) {
    return {
      value: manual,
      source: "manager_input",
      confidence: "high",
      note: "Площадь указана менеджером в форме.",
    };
  }

  const roofAreaPatterns = [
    new RegExp(`(?:площадь\\s+(?:кровли|покрытия))\\s*,?\\s*(?:м\\s*2|м2|м²|кв\\.?\\s*м)\\s*${NUMBER}`, "i"),
    new RegExp(`(?:площадь\\s+(?:кровли|покрытия)|s\\s*(?:кровли|покрытия))[^\\d]{0,30}${NUMBER}\\s*(?:м2|м²|кв\\.?\\s*м)`, "i"),
    new RegExp(`${NUMBER}\\s*(?:м2|м²|кв\\.?\\s*м)\\s*(?:[-–—:]\\s*)?(?:площад[ьи]\\s+)?(?:кровли|покрытия)`, "i"),
  ];

  for (const pattern of roofAreaPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return {
        value: toNumber(match[1]),
        source: "pdf_text",
        confidence: "medium",
        note: "Площадь найдена в тексте PDF. Перед счетом желательно сверить с ведомостью/планом кровли.",
      };
    }
  }

  const roofSpecAreas = extractRoofSpecAreas(text);
  if (roofSpecAreas.membraneTotalArea > 0) {
    return {
      value: roofSpecAreas.membraneTotalArea,
      source: "pdf_text",
      confidence: "medium",
      note: roofSpecAreas.sandwichRoofArea > 0
        ? `Площадь мембранной кровли взята из спецификации кровельного покрытия как запасной источник. Отдельно найден тип кровли из сэндвич-панелей ${roofSpecAreas.sandwichRoofArea} м2; его считать отдельно по ведомости/номенклатуре.`
        : "Площадь мембранной кровли взята из спецификации кровельного покрытия как запасной источник, потому что строка «Площадь кровли» не найдена.",
    };
  }

  const plastfoilMainArea = detectPlastfoilLayers(text.toLowerCase())
    .find((layer) => layer.key === "pvc_plastfoil_classic")?.areaOverride;
  if (plastfoilMainArea && plastfoilMainArea > 0) {
    return {
      value: round(plastfoilMainArea, 2),
      source: "pdf_text",
      confidence: "medium",
      note: "Площадь основной ПВХ-мембраны Plastfoil Classic взята из спецификации элементов кровли как запасной источник. В проекте указано, что объем дан без учета раскладки и раскроя; для счета сверить с ведомостью кровли.",
    };
  }

  const axesContexts = Array.from(text.matchAll(/(?:размер(?:ы|ами)|осях|в\s+осях)[\s\S]{0,220}/gi)).map((match) => match[0]);
  const axesDimensionMatches = axesContexts.flatMap((context) =>
    Array.from(context.matchAll(/(\d{2,4}(?:[,.]\d+)?)\s*[xхХ*]\s*(\d{2,4}(?:[,.]\d+)?)\s*м/gi))
  );
  for (const match of axesDimensionMatches) {
    const first = match[1] ? toNumber(match[1]) : NaN;
    const second = match[2] ? toNumber(match[2]) : NaN;
    const area = first * second;
    if (first > 0 && second > 0 && first <= 1000 && second <= 1000 && area > 0) {
      return {
        value: round(area, 2),
        source: "axes_estimate",
        confidence: "low",
        note: `Площадь оценена по габаритам в осях ${first} x ${second} м. Для счета нужна площадь кровли по проекту/плану кровли.`,
        dimensions: {
          lengthM: first,
          widthM: second,
          perimeterM: round((first + second) * 2, 2),
          source: "axes_dimensions",
        },
      };
    }
  }

  const axesMatch = text.match(new RegExp(`(?:размеры|осях|в\\s+осях)[^\\d]{0,80}${NUMBER}\\s*м?\\s*[xхХ*]\\s*${NUMBER}\\s*м`, "i"));
  if (axesMatch?.[1] && axesMatch?.[2]) {
    const first = toNumber(axesMatch[1]);
    const second = toNumber(axesMatch[2]);
    const area = first * second;
    if (area > 0) {
      return {
        value: round(area, 2),
        source: "axes_estimate",
        confidence: "low",
        note: `Площадь оценена по габаритам в осях ${first} x ${second} м. Для счета нужна площадь кровли по проекту.`,
        dimensions: {
          lengthM: first,
          widthM: second,
          perimeterM: round((first + second) * 2, 2),
          source: "axes_dimensions",
        },
      };
    }
  }

  const roofPlanMetrics = detectRoofPlanDimensionMetrics(text);
  if (roofPlanMetrics) {
    return {
      value: roofPlanMetrics.area,
      source: "roof_plan_estimate",
      confidence: "low",
      note: `Площадь предварительно оценена по габаритной размерной цепочке плана кровли: ${roofPlanMetrics.first} x ${roofPlanMetrics.second} м. Ориентир периметра для парапетов/примыканий: ${roofPlanMetrics.perimeter} м. Для счета нужно сверить контур, вырезы, перепады и ведомость кровли.`,
      dimensions: {
        lengthM: roofPlanMetrics.first,
        widthM: roofPlanMetrics.second,
        perimeterM: roofPlanMetrics.perimeter,
        source: "roof_plan_dimensions",
      },
    };
  }

  return {
    value: null,
    source: "not_found",
    confidence: "none",
    note: "Площадь кровли в тексте PDF не найдена. Укажите площадь в форме или в сообщении менеджера.",
  };
}

function detectUnitCount(text: string, keyword: RegExp) {
  const keywordPattern = new RegExp(keyword.source, "i");
  const unitMatches = Array.from(text.matchAll(/(\d{1,4})\s*шт/gi));
  for (const match of unitMatches) {
    const index = match.index ?? 0;
    const context = text.slice(Math.max(0, index - 320), index + 320);
    const hasFunnelQuantityTable =
      /спецификац[\s\S]{0,140}воронк|ведомост[\s\S]{0,140}воронк|воронк[\s\S]{0,140}(?:кол-?во|количество)/i.test(context);
    const isTypicalNodeQuantity =
      /типов[а-я\s-]*узел|узел\s*\(?\d|состав\s+кровли|состав\s+узла|фартук[\s\S]{0,80}воронк|листвоуловитель|дренажн[а-я\s-]*кольц/i.test(context)
      && !hasFunnelQuantityTable;
    if (isTypicalNodeQuantity) continue;
    if (keywordPattern.test(context)) return Number(match[1]);
  }
  return undefined;
}

function detectRoofDrainLabelCount(text: string) {
  if (!looksLikeRoofPlan(text) && !/водосток|воронк|план\s+кровл/i.test(text)) return undefined;

  const labels = new Set<string>();
  for (const match of text.matchAll(/\b(в[вп])\s*[-–—]?\s*(\d{1,3})\b/gi)) {
    const prefix = (match[1] ?? "").toLowerCase();
    const number = match[2] ?? "";
    if (!number) continue;
    labels.add(`${prefix}-${number}`);
  }

  return labels.size > 0 ? labels.size : undefined;
}

function normalizeRoofStatementText(text: string) {
  return normalizeText(text)
    .replace(/logi\s+croof/gi, "LOGICROOF")
    .replace(/logi\s+cpir/gi, "LOGICPIR")
    .replace(/м\s*²/gi, "м2")
    .replace(/м\s*³/gi, "м3")
    .toLowerCase();
}

function uniqueNumbers(values: number[]) {
  const seen = new Set<string>();
  const result: number[] = [];
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const key = round(value, 3).toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function extractQuantitiesAfterMaterial(statementText: string, materialPattern: RegExp, unit: "m2" | "m3") {
  const result: number[] = [];
  const re = new RegExp(materialPattern.source, materialPattern.flags.includes("i") ? "gi" : "g");
  const unitPattern = unit === "m2" ? String.raw`м2|м²` : String.raw`м3|м³`;

  for (const match of statementText.matchAll(re)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    const before = statementText.slice(Math.max(0, index - 550), index);
    const after = statementText.slice(index, index + 420);
    const hasStatementContext = /ведомость\s+материалов\s+кровли|обозначение\s+наименование\s+толщина|(?:^|\s)к\d(?:[.,]\d)?\s*$|(?:^|\s)к\d(?:[.,]\d)?\s+сто/i.test(before);
    const quantityMatch = after.match(new RegExp(String.raw`(?:^|[^\d,.])(\d{1,6}(?:[,.]\d{1,2})?)\s*(?:${unitPattern})`, "i"));
    if (!quantityMatch?.[1]) continue;
    const value = toNumber(quantityMatch[1]);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (unit === "m2" && value < 10) continue;
    if (!hasStatementContext && unit === "m2" && value < 500) continue;
    if (!hasStatementContext && unit === "m3" && !/кровельн[а-я\s-]*пвх|logicpir|паробарьер|м2|сто/i.test(before)) continue;
    result.push(value);
  }

  return uniqueNumbers(result);
}

function sumQuantities(values: number[]) {
  return round(values.reduce((sum, value) => sum + value, 0), 3);
}

function extractRoofMaterialStatementQuantities(text: string) {
  const statement = normalizeRoofStatementText(text);
  const logicroofVrpM2 = extractQuantitiesAfterMaterial(statement, /кровельн[а-я\s-]*пвх\s+мембран[а-я\s-]*logicroof\s+v-rp|гидроизоляционн[а-я\s-]*мембран[а-я\s-]*logicroof\s+v-rp|logicroof\s+v-rp/i, "m2");
  const logicpirProfM2 = extractQuantitiesAfterMaterial(statement, /плит[а-я\s-]*теплоизоляционн[а-я\s-]*logicpir\s+prof|logicpir\s+prof/i, "m2");
  const carbonProfSlopeM3 = extractQuantitiesAfterMaterial(statement, /(?:экструзионн[а-я\s-]*пенополистирол\s+)?технониколь\s+carbon\s+prof\s+slope|carbon\s+prof\s+slope/i, "m3");
  const technorufNProf50M3 = extractQuantitiesAfterMaterial(statement, /минераловатн[а-я\s-]*утеплител[а-я\s-]*технор[уо]ф\s+н\s+проф|технор[уо]ф\s+н\s+проф/i, "m3");
  const parobarrierCa500M2 = extractQuantitiesAfterMaterial(statement, /паробарьер\s+[сc][аa]\s*500/i, "m2");
  const geotextile300M2 = extractQuantitiesAfterMaterial(statement, /иглопробивн[а-я\s-]*геотекстил[а-я\s-]*технониколь\s+300|геотекстил[а-я\s-]*технониколь\s+300/i, "m2");

  return {
    logicroofVrpM2: sumQuantities(logicroofVrpM2),
    logicpirProfM2: sumQuantities(logicpirProfM2),
    carbonProfSlopeM3: sumQuantities(carbonProfSlopeM3),
    technorufNProf50M3: sumQuantities(technorufNProf50M3),
    parobarrierCa500M2: sumQuantities(parobarrierCa500M2),
    geotextile300M2: sumQuantities(geotextile300M2),
  };
}

function detectParapetFunnelCount(text: string) {
  const matches = Array.from(text.matchAll(/спецификация парапетных воронок[\s\S]{0,500}?вп-1[\s\S]{0,300}?(\d{1,3})(?=\s+спецификация|\s+марка|\s+\d+\.\d|$)/gi));
  const total = matches.reduce((sum, match) => sum + Number(match[1] ?? 0), 0);
  return total > 0 ? total : undefined;
}

function findNearestAreaM2Match(text: string, index: number) {
  const start = Math.max(0, index - 900);
  const window = text.slice(start, index + 900);
  const matches = Array.from(window.matchAll(/(\d{1,3}(?:\s+\d{3})+|\d+(?:[,.]\d+)?)\s*\*?\s*(?:м\s*2|м2|м²)/gi))
    .map((match) => {
      const value = match[1] ? toLooseNumber(match[1]) : NaN;
      return {
        value,
        distance: Math.abs(start + (match.index ?? 0) - index),
      };
    })
    .filter((match) => Number.isFinite(match.value) && match.value > 10)
    .sort((a, b) => a.distance - b.distance);

  return matches[0];
}

function findPlastfoilMaterialMatch(text: string, pattern: RegExp) {
  const re = new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g");
  let fallbackIndex = -1;
  let best: { index: number; area?: number; distance?: number } | null = null;

  for (const match of text.matchAll(re)) {
    const index = match.index ?? -1;
    if (index < 0) continue;
    if (fallbackIndex < 0) fallbackIndex = index;

    const areaMatch = findNearestAreaM2Match(text, index);
    if (!areaMatch) continue;
    if (!best || (areaMatch.distance ?? Number.MAX_SAFE_INTEGER) < (best.distance ?? Number.MAX_SAFE_INTEGER)) {
      best = { index, area: areaMatch.value, distance: areaMatch.distance };
    }
  }

  return best ?? (fallbackIndex >= 0 ? { index: fallbackIndex } : null);
}

function parsePlastfoilThicknessNear(text: string, index: number) {
  const context = text.slice(index, index + 180);
  const explicitMm = context.match(/(?:plastfoil|пластфойл|classic|classi[сc]|art)[\s\S]{0,90}?(\d(?:[,.]\d)?)\s*мм/i);
  if (explicitMm?.[1]) return toNumber(explicitMm[1]);

  const sizeLike = context.match(/\((\d(?:[,.]\d)?)\s*[xх*]\s*\d{3,5}/i);
  return sizeLike?.[1] ? toNumber(sizeLike[1]) : undefined;
}

function detectPlastfoilLayers(lower: string): DetectedLayer[] {
  const layers: DetectedLayer[] = [];
  const classicMatch = findPlastfoilMaterialMatch(lower, /plastfoil\s+classic|пластфойл[\s\S]{0,30}classic/i);
  const artMatch = findPlastfoilMaterialMatch(lower, /plastfoil\s+art|пластфойл[\s\S]{0,30}art/i);

  if (classicMatch) {
    const area = classicMatch.area;
    const thicknessMm = parsePlastfoilThicknessNear(lower, classicMatch.index) ?? 1.2;
    const thicknessRu = String(thicknessMm).replace(".", ",");
    layers.push({
      key: "pvc_plastfoil_classic",
      role: "кровельная ПВХ-мембрана",
      label: `Plastfoil Classic ${thicknessRu} мм`,
      detected: true,
      searchTerms: [
        `PLASTFOIL classic ${thicknessRu}`,
        `Plastfoil Classic ${thicknessMm}`,
        "PLASTFOIL classic",
        "ПЛАСТФОЙЛ classic",
        "Plastfoil Classic",
        "ПЛАСТФОЙЛ",
      ],
      factor: 1.15,
      thicknessMm,
      areaOverride: area,
      quantityType: "m2",
      note: area
        ? "Площадь Plastfoil Classic взята из спецификации элементов кровли. В примечании проекта указано, что объем дан без учета раскладки и раскроя; расчет рулонов сделан с коэффициентом 1,15."
        : `В проекте указана Plastfoil Classic ${thicknessRu} мм, но площадь в строке спецификации не распознана.`,
    });
  }

  if (artMatch) {
    const area = artMatch.area;
    layers.push({
      key: "pvc_plastfoil_art",
      role: "дополнительная неармированная ПВХ-мембрана для примыканий",
      label: "Plastfoil Art 1,5 мм",
      detected: true,
      searchTerms: ["PLASTFOIL ART 1,5", "ПЛАСТФОЙЛ ART 1,5", "Plastfoil Art", "ПЛАСТФОЙЛ"],
      factor: 1.15,
      thicknessMm: 1.5,
      areaOverride: area,
      quantityType: "m2",
      note: area
        ? "Площадь Plastfoil Art взята из спецификации/узлов как дополнительная неармированная ПВХ-мембрана. В примечании проекта указано, что объем дан без учета раскладки и раскроя; расчет рулонов сделан с коэффициентом 1,15."
        : "В проекте указана Plastfoil Art 1,5 мм, но площадь в строке спецификации не распознана.",
    });
  }

  return layers;
}

function detectGeberitPluviaCount(text: string) {
  const directMatch = text.match(/(?:водосточн[а-я\s-]*воронк[а-я\s"«»]*)?geberit\s+pluvia["»]?\s+(\d{1,4})/i);
  return directMatch?.[1] ? Number(directMatch[1]) : undefined;
}

function detectRoofWoolLayers(lower: string): DetectedLayer[] {
  const result = new Map<string, DetectedLayer>();

  const addTechnorufNamedLayer = (letter: string, grade: string, thickness: string) => {
    const normalizedLetter = letter.toLowerCase() === "в" ? "В" : "Н";
    const normalizedGrade = grade.toLowerCase();
    const gradeLabel = normalizedGrade === "экстра"
      ? "ЭКСТРА"
      : normalizedGrade === "проф"
        ? "ПРОФ"
        : "ОПТИМА";
    const thicknessMm = Number(thickness);
    if (!Number.isFinite(thicknessMm)) return;

    const key = `technoruf_${normalizedLetter.toLowerCase()}_${gradeLabel.toLowerCase()}_${thicknessMm}`;
    result.set(key, {
      key,
      role: normalizedLetter === "В" ? "верхний слой теплоизоляции кровли" : "нижний слой теплоизоляции кровли",
      label: `ТЕХНОРУФ ${normalizedLetter} ${gradeLabel} ${thicknessMm} мм`,
      detected: true,
      searchTerms: [
        `ТЕХНОРУФ ${normalizedLetter} ${gradeLabel} ${thicknessMm}`,
        `ТЕХНОРУФ ${normalizedLetter} ${gradeLabel}`,
        `ТЕХНОРУФ ${gradeLabel} ${thicknessMm}`,
      ],
      factor: 1.03,
      thicknessMm,
      quantityType: "m3",
      note: "Марка и толщина теплоизоляции взяты из таблицы состава кровли; перед КП сверить с ведомостью кровли.",
    });
  };

  const addTechnorufLayer = (letter: string, density: string, thickness: string) => {
    const normalizedLetter = letter.toLowerCase() === "в" ? "В" : "Н";
    const densityLabel = `${normalizedLetter}${density}`;
    const thicknessMm = Number(thickness);
    if (!Number.isFinite(thicknessMm)) return;

    const key = `technoruf_${normalizedLetter.toLowerCase()}${density}_${thicknessMm}`;
    result.set(key, {
      key,
      role: normalizedLetter === "В" ? "верхний слой теплоизоляции кровли" : "нижний слой теплоизоляции кровли",
      label: `Техноруф ${densityLabel} ${thicknessMm} мм`,
      detected: true,
      searchTerms: [
        `ТЕХНОРУФ ${densityLabel} ${thicknessMm}`,
        `ТЕХНОРУФ ${normalizedLetter} ${density} ${thicknessMm}`,
        `ТЕХНОРУФ ${densityLabel}`,
      ],
      factor: 1.03,
      thicknessMm,
      quantityType: "m3",
      note: "Марку, плотность и толщину теплоизоляции сверить по ведомости кровли/КР перед КП.",
    });
  };

  for (const match of lower.matchAll(/технор[уо]ф\s*([вн])\s*(экстра|проф|оптима)\s*[-–—]?\s*(\d{2,3})(?:\s*мм)?/gi)) {
    const index = match.index ?? 0;
    const context = lower.slice(Math.max(0, index - 360), index + 360);
    if (/кровл|logicroof|профлист|мембран|паробарьер|состав/i.test(context)) {
      addTechnorufNamedLayer(match[1], match[2], match[3]);
    }
  }

  if (result.size) return Array.from(result.values());

  for (const match of lower.matchAll(/технор[уо]ф\s*([вн])\s*(\d{2,3})\s*[-–—]?\s*(\d{2,3})\s*мм/gi)) {
    const index = match.index ?? 0;
    const context = lower.slice(Math.max(0, index - 260), index + 260);
    if (/кровл|logicroof|профлист|мембран|гидроветрозащит/i.test(context)) {
      addTechnorufLayer(match[1], match[2], match[3]);
    }
  }

  if (result.size) return Array.from(result.values());

  for (const match of lower.matchAll(/кровл[а-я\s—–-]{0,220}минераловатн[а-я\s—–-]*утеплител[а-я\s—–-]*(?:t\s*=\s*)?(\d{2,3})\s*мм/gi)) {
    const thicknessMm = Number(match[1]);
    if (!Number.isFinite(thicknessMm)) continue;

    result.set("roof_mw", {
      key: "roof_mw",
      role: "теплоизоляция кровли",
      label: `Минераловатный утеплитель кровли ${thicknessMm} мм`,
      detected: true,
      searchTerms: [
        `ТЕХНОРУФ Н ПРОФ ${thicknessMm}`,
        `ТЕХНОРУФ Н ОПТИМА ${thicknessMm}`,
        `BASWOOL РУФ Н ${thicknessMm}`,
      ],
      factor: 1.03,
      thicknessMm,
      quantityType: "m3",
      note: "В проекте указана минвата кровли; конкретную марку/схему слоев сверить по проекту КР/КО или спецификации.",
    });
    break;
  }

  return Array.from(result.values());
}

function detectLayers(text: string, question = ""): DetectedLayer[] {
  const lower = `${text} ${question}`.toLowerCase();
  const hasRoofPlanContext = looksLikeRoofPlan(text);
  const roofStatementQuantities = extractRoofMaterialStatementQuantities(text);
  const hasPvcRoofSystem = includesAny(lower, [/logicroof/i, /plastfoil|пластфойл/i, /ecoplast/i, /пвх[а-я\s-]*мембран/i, /полимерн[а-я\s-]*мембран/i]);
  const xpsThicknessMatch = lower.match(/(?:xps|эппс|экструдированн[а-я\s-]*пенополистирол|экструзионн[а-я\s-]*пенополистирол|пенополистирол|carbon\s+prof)[^\d]{0,80}(\d{2,3})\s*мм/i);
  const xpsThicknessMm = xpsThicknessMatch?.[1] ? Number(xpsThicknessMatch[1]) : undefined;
  const roofSpecAreas = extractRoofSpecAreas(lower);
  const pvcMembraneThicknessMatch = lower.match(/logicroof\s+v-rp[\s\S]{0,80}?(\d(?:[,.]\d)?)\s*мм/i)
    ?? lower.match(/logicroof\s+v-rp[^\d]{0,40}(1[,.][258]|2[,.]0|2)/i)
    ?? lower.match(/(?:пвх[а-я\s-]*мембран|полимерн[а-я\s-]*мембран)[^\d]{0,50}(\d(?:[,.]\d)?)\s*мм/i);
  const pvcMembraneThicknessMm = pvcMembraneThicknessMatch?.[1] ? toNumber(pvcMembraneThicknessMatch[1]) : undefined;
  const hasLogicroofVrpFr = /logicroof\s+v[-\s]*rp\s*fr/i.test(lower);
  const hasPvcMembraneG1Requirement = /(?:logicroof\s+v[-\s]*rp|пвх[а-я\s-]*мембран|полимерн[а-я\s-]*мембран)[\s\S]{0,140}?(?:г\s*1|g\s*1)|(?:г\s*1|g\s*1)[\s\S]{0,140}?(?:logicroof\s+v[-\s]*rp|пвх[а-я\s-]*мембран|полимерн[а-я\s-]*мембран)/i.test(lower);
  const hasPvcMembraneG1ThicknessConflict = hasPvcMembraneG1Requirement && pvcMembraneThicknessMm === 1.5;
  const hasCarbonProfSlope = /carbon\s+prof\s+slope|карбон\s+проф\s+slope/i.test(lower);
  const hasPlainCarbonProf = /carbon\s+prof(?!\s+slope)|карбон\s+проф(?!\s+slope)/i.test(lower);
  const hasCarbonProf = hasPlainCarbonProf;
  const roofWoolLayers = detectRoofWoolLayers(lower);
  const hasSegmentedRoofSpec = roofSpecAreas.membraneOnConcreteArea > 0 || roofSpecAreas.membraneOnProfiledSheetArea > 0;
  const roofWoolLayersForUse = roofWoolLayers.filter((layer) => {
    if (
      hasSegmentedRoofSpec &&
      /технор[уо]ф\s+н\s+проф/i.test(layer.label) &&
      layer.thicknessMm === 100 &&
      roofSpecAreas.membraneOnProfiledSheetArea > 0
    ) {
      return false;
    }
    return true;
  });
  const roofWoolLayersWithStatementQuantities = roofWoolLayersForUse.map((layer) => {
    const isTechnorufNProf50 =
      /технор[уо]ф\s+н\s+проф/i.test(layer.label) &&
      layer.thicknessMm === 50 &&
      roofStatementQuantities.technorufNProf50M3 > 0;

    if (!isTechnorufNProf50) return layer;
    return {
      ...layer,
      quantityOverride: {
        value: roofStatementQuantities.technorufNProf50M3,
        unit: "m3" as const,
        source: "Объем ТЕХНОРУФ Н ПРОФ 50 мм взят из ведомости материалов кровли.",
      },
      note: "Объем ТЕХНОРУФ Н ПРОФ 50 мм взят из ведомости материалов кровли; перед КП сверить, что все типы кровли идут одной маркой и толщиной.",
    };
  });
  const plastfoilLayers = detectPlastfoilLayers(lower);
  const mainPvcMembraneArea = plastfoilLayers.find((layer) => layer.key === "pvc_plastfoil_classic")?.areaOverride
    ?? (roofSpecAreas.membraneTotalArea > 0 ? roofSpecAreas.membraneTotalArea : undefined);
  const hasParobarrierCa500 = /паробарьер\s*[сc][аa]\s*500|[сc][аa]\s*500/i.test(lower);
  const hasParobarrierC = /паробарьер\s*[сc](?![аa]\s*500)/i.test(lower);
  const hasTechnobarrier = /технобарьер/i.test(lower);
  const hasSegmentedVaporBarrierSpec = hasSegmentedRoofSpec && hasTechnobarrier && (hasParobarrierC || hasParobarrierCa500);
  const hasExactHydrowindMembrane =
    /альфа\s+(?:вент|топ)|мастер\s+вент|georex|гидро-?ветрозащитн[\s\S]{0,80}технониколь|технониколь[\s\S]{0,80}гидро-?ветрозащитн/i.test(lower);
  const hasExternalRoofDrainage = includesAny(lower, [
    /наружн[а-я\s-]*организованн[а-я\s-]*водосток/i,
    /водосточн[а-я\s-]*желоб/i,
    /водосборн[а-я\s-]*воронк/i,
  ]);
  const hasGeberitPluvia = /geberit\s+pluvia|геберит\s+плювиа/i.test(lower);
  const hasParapetFunnel = includesAny(lower, [/воронк[а-я\s-]*парапет/i, /парапет[а-я\s-]*воронк/i]);
  const hasSquareParapetFunnel = hasParapetFunnel && /100\s*[xх*]\s*100\s*[xх*]\s*600/i.test(lower);
  const hasInternalFunnelOnRoofPlan = hasRoofPlanContext && /воронк[\s\S]{0,120}внутренн[\s\S]{0,60}водосток/i.test(lower);
  const roofDrainLabelCount = detectRoofDrainLabelCount(text);
  const geberitPluviaUnitCount = hasGeberitPluvia ? detectGeberitPluviaCount(lower) : undefined;
  const funnelUnitCount = hasParapetFunnel
    ? detectParapetFunnelCount(lower) ?? detectUnitCount(lower, /воронк[а-я]*/) ?? roofDrainLabelCount
    : detectUnitCount(lower, /воронк[а-я]*/) ?? roofDrainLabelCount;

  const keramzitSlope = lower.match(/керамзит[а-я\s-]*грав[а-я\s-]*?(\d{2,3})\s*(?:\.{2,3}|-)\s*(\d{2,3})\s*мм/i);
  const keramzitAvg = keramzitSlope?.[1] && keramzitSlope?.[2]
    ? (Number(keramzitSlope[1]) + Number(keramzitSlope[2])) / 2
    : undefined;

  const layers: DetectedLayer[] = [
    {
      key: "pvc_logicroof_vrp",
      role: "кровельная ПВХ-мембрана",
      label: pvcMembraneThicknessMm ? `LOGICROOF V-RP${hasLogicroofVrpFr ? " FR" : ""} ${pvcMembraneThicknessMm} мм` : `LOGICROOF V-RP${hasLogicroofVrpFr ? " FR" : ""}`,
      detected: includesAny(lower, [/logicroof\s+v-rp/i, /полимерн[а-я\s-]*мембран[а-я\s-]*logicroof/i]),
      searchTerms: pvcMembraneThicknessMm
        ? [
          `Logicroof V-RP${hasLogicroofVrpFr ? " FR" : ""} ${String(pvcMembraneThicknessMm).replace(".", ",")}`,
          `Logicroof V-RP${hasLogicroofVrpFr ? " FR" : ""} ${pvcMembraneThicknessMm}`,
          "ПВХ Logicroof V-RP",
        ]
        : [],
      factor: 1.15,
      areaOverride: roofSpecAreas.membraneTotalArea > 0 ? roofSpecAreas.membraneTotalArea : undefined,
      quantityOverride: roofStatementQuantities.logicroofVrpM2 > 0
        ? {
          value: roofStatementQuantities.logicroofVrpM2,
          unit: "m2",
          source: "Количество LOGICROOF V-RP взято из ведомости материалов кровли.",
        }
        : undefined,
      quantityType: "m2",
      thicknessMm: pvcMembraneThicknessMm,
      reviewOnly: hasPvcMembraneG1ThicknessConflict,
      note: pvcMembraneThicknessMm
        ? hasPvcMembraneG1ThicknessConflict
          ? "В проекте одновременно указаны LOGICROOF V-RP 1,5 мм и требование Г1/G1. По правилу менеджера это конфликт: Г1-мембрана обычно идет 1,2 мм; нужно уточнить, что важнее заказчику — толщина 1,5 мм или группа горючести Г1."
          : "Марку и толщину мембраны сверить по проекту перед КП."
        : roofStatementQuantities.logicroofVrpM2 > 0
          ? "Количество LOGICROOF V-RP взято из ведомости материалов кровли, но толщина мембраны не указана; код 1С и счетную позицию ставить только после уточнения толщины 1,2/1,5/1,8/2,0 мм."
          : "В проекте указана LOGICROOF V-RP без толщины; код 1С и счетную позицию ставить только после уточнения толщины 1,2/1,5/1,8/2,0 мм.",
    },
    {
      key: "glass_fleece_100",
      role: "разделительный слой",
      label: "Стеклохолст 100 г/м2",
      detected: includesAny(lower, [/стеклохолст[\s\S]{0,40}100\s*(?:г|гр|g)\s*\/?\s*(?:м2|м²|m2)/i]),
      searchTerms: ["Стеклохолст ТехноНИКОЛЬ 100", "Стеклохолст 100", "Стеклохолст"],
      factor: 1.18,
      quantityType: "m2",
      note: "Разделительный слой системы ПВХ-кровли; количество считать по площади кровли с коэффициентом системы.",
    },
    {
      key: "geotextile_tn_300_statement",
      role: "разделительный слой/геотекстиль",
      label: "Иглопробивной геотекстиль ТЕХНОНИКОЛЬ 300 г/м2",
      detected: roofStatementQuantities.geotextile300M2 > 0,
      searchTerms: ["Геотекстиль ТЕХНОНИКОЛЬ 300", "Геотекстиль 300", "Иглопробивной геотекстиль 300"],
      quantityType: "m2",
      reviewOnly: true,
      quantityOverride: roofStatementQuantities.geotextile300M2 > 0
        ? {
          value: roofStatementQuantities.geotextile300M2,
          unit: "m2",
          source: "Количество геотекстиля взято из ведомости материалов кровли.",
        }
        : undefined,
      note: "Геотекстиль найден в ведомости материалов кровли; перед КП сверить, относится ли он к типу кровли К4/козырьки или к основному пирогу.",
    },
    ...plastfoilLayers,
    {
      key: "dirock_ruf_n_60",
      role: "нижний минераловатный слой утепления кровли",
      label: "Dirock РУФ Н 115 кг/м3, 60 мм",
      detected: includesAny(lower, [/dirock\s+руф\s+н[\s\S]{0,120}?60\s*мм/i]),
      searchTerms: ["ТЕХНОРУФ Н ПРОФ 1200х600х60", "ТЕХНОРУФ Н ПРОФ 60", "ТЕХНОРУФ Н 60", "Dirock РУФ Н 60"],
      factor: 1.03,
      thicknessMm: 60,
      areaOverride: mainPvcMembraneArea,
      quantityType: "m3",
      reviewOnly: true,
      note: "В проекте указан Dirock РУФ Н 115 кг/м3 60 мм или аналог. Точную замену на ТЕХНОРУФ/другую минвату согласовать по системе К0 и пожарному сертификату.",
    },
    {
      key: "pirromembrane_70",
      role: "верхний PIR-слой утепления кровли",
      label: "PirroMembrane 70 мм",
      detected: includesAny(lower, [/pirromembrane[\s\S]{0,120}?70\s*мм/i, /pir-плит[а-я\s"«»]*pirromembrane[\s\S]{0,120}?70\s*мм/i]),
      searchTerms: ["PirroMembrane 70", "LOGICPIR PROF Ф/Ф 70", "LOGICPIR PROF 70"],
      factor: 1.03,
      thicknessMm: 70,
      areaOverride: mainPvcMembraneArea,
      quantityType: "m3",
      reviewOnly: true,
      note: "В проекте указаны PIR-плиты PirroMembrane 70 мм или аналог в системе Комби PIR. Аналог LOGICPIR/PIR подбирать только после согласования системы и пожарного сертификата К0.",
    },
    {
      key: "roof_fastener_telescopic_130",
      role: "крепеж ПВХ-мембраны/утеплителя",
      label: "Телескопический крепеж с саморезом Ø5,5х35 мм",
      detected: includesAny(lower, [/телескопическ[а-я\s-]*креп[её]ж[\s\S]{0,80}?саморез[\s\S]{0,30}(?:5[,.]5|5,5|5\.5)\s*[xх*]\s*35/i, /телескопическ[а-я\s-]*шайб[а-я\s-]*на\s+саморез[еа][\s\S]{0,30}(?:5[,.]5|5,5|5\.5)\s*[xх*]\s*35/i]),
      searchTerms: ["Телескопический крепеж TERMOCLIP 1 / 130 мм", "Телескопический крепеж TERMOCLIP 1 / 140 мм", "Саморез сверлоконечный 5,5х35"],
      quantityType: "project",
      reviewOnly: true,
      note: "В проекте указан механический монтаж к профлисту. Количество крепежа считать по ветровому расчету и схеме крепления; длину телескопа/самореза сверить по толщине пирога 60+70 мм и основанию.",
    },
    {
      key: "pvc_clamping_rail",
      role: "узлы примыкания/прижимная рейка",
      label: "Прижимная рейка",
      detected: includesAny(lower, [/прижимн[а-я\s-]*рейк/i]),
      searchTerms: ["Прижимная алюминиевая рейка"],
      quantityType: "project",
      reviewOnly: true,
      note: "Прижимную рейку считать по длинам примыканий, парапетов и узлов; количество не выводить из общей площади кровли.",
    },
    {
      key: "pvc_metal_flashing",
      role: "доборные элементы ПВХ-кровли",
      label: "ПВХ-металл / оцинкованный Г-образный лист 0,6 мм",
      detected: includesAny(lower, [/лист\s+из\s+оцинкованн[а-я\s-]*стали\s+г-образн[\s\S]{0,30}0[,.]6/i, /пвх[\s-]*металл/i]),
      searchTerms: ["ПВХ металл", "PLASTFOIL FERROPLAST"],
      quantityType: "project",
      reviewOnly: true,
      note: "Доборные элементы считать по узлам и длинам примыканий; замену оцинкованного Г-профиля на ПВХ-металл согласовать по узлам.",
    },
    {
      key: "pvc_detail_membrane_default",
      role: "комплектация ПВХ-узлов/примыканий",
      label: "Неармированная ПВХ-мембрана для примыканий и обводок",
      detected: hasPvcRoofSystem && includesAny(lower, [/примыкан|парапет|воронк|узл|обводк|пвх|logicroof/i]),
      searchTerms: ["ПВХ Logicroof V-SR 1,5", "Logicroof V-SR", "ПВХ мембрана неармированная", "Plastfoil Art"],
      quantityType: "project",
      reviewOnly: true,
      note: "По правилу менеджера ПВХ-комплектацию узлов добавлять к проверке: неармированная мембрана нужна для примыканий, углов и обводок. Количество считать по узлам/периметру/ведомости, не по общей площади кровли.",
    },
    {
      key: "pvc_cleaner_default",
      role: "комплектация ПВХ-кровли/очистка швов",
      label: "Очиститель для ПВХ-мембран",
      detected: hasPvcRoofSystem,
      searchTerms: ["Очиститель для ПВХ мембран ТехноНИКОЛЬ", "Спрей-очиститель для ПВХ мембран", "Очиститель ПВХ мембран"],
      quantityType: "project",
      reviewOnly: true,
      note: "Добавлять к проверке для сварки ПВХ: очиститель нужен перед проваркой загрязненных швов и узлов. Количество считать по площади/узлам или по калькулятору, без нормы в проекте автоматически в счет не ставить.",
    },
    {
      key: "liquid_pvc_default",
      role: "комплектация ПВХ-кровли/герметизация швов",
      label: "Жидкий ПВХ",
      detected: hasPvcRoofSystem,
      searchTerms: ["Жидкий ПВХ ТехноНИКОЛЬ серый 1л", "Жидкий ПВХ ТН серый 1л", "Жидкий ПВХ"],
      quantityType: "project",
      reviewOnly: true,
      note: "Добавлять к проверке для промазки швов и проходок на примыканиях. Количество зависит от узлов и карты сварки; без нормы/ведомости в счет не ставить.",
    },
    {
      key: "roof_aerator",
      role: "узлы кровли/аэраторы",
      label: "Кровельный аэратор",
      detected: includesAny(lower, [/аэратор/i]),
      searchTerms: ["Аэратор кровельный ТехноНИКОЛЬ", "Аэратор кровельный", "ПВХ аэратор кровельный"],
      quantityType: "project",
      unitCount: detectUnitCount(lower, /аэратор[а-я]*/),
      reviewOnly: true,
      note: "Аэраторы считать по узлам проекта или по калькулятору; если проект не задает количество, вынести на согласование.",
    },
    {
      key: "roof_walkway",
      role: "эксплуатационные дорожки",
      label: "Пешеходная/техническая дорожка по кровле",
      detected: includesAny(lower, [/дорожк[а-я\s-]*кровл|пешеходн[а-я\s-]*дорожк|walkway|логикруф[\s\S]{0,40}пазл|puzzle/i]),
      searchTerms: ["LOGICROOF Walkway Puzzle", "ПВХ Logicroof Walkway Puzzle", "Дорожка пешеходная кровельная"],
      quantityType: "project",
      reviewOnly: true,
      note: "Дорожки считать в погонных метрах/штуках по плану перемещения и обслуживания оборудования; если длина не указана, в счет не ставить.",
    },
    {
      key: "logicpir_prof_statement_40",
      role: "теплоизоляция LOGICPIR",
      label: "LOGICPIR PROF Ф/Ф 40 мм",
      detected: roofStatementQuantities.logicpirProfM2 > 0,
      searchTerms: ["LOGICPIR PROF Ф/Ф 40", "LOGICPIR PROF 40", "LOGICPIR PROF Ф/Ф"],
      thicknessMm: 40,
      quantityType: "m2",
      quantityOverride: roofStatementQuantities.logicpirProfM2 > 0
        ? {
          value: roofStatementQuantities.logicpirProfM2,
          unit: "m2",
          source: "Количество LOGICPIR PROF взято из ведомости материалов кровли.",
        }
        : undefined,
      note: "Количество LOGICPIR PROF взято из ведомости материалов кровли; перед КП сверить, что все типы кровли допускают одну позицию LOGICPIR PROF Ф/Ф 40 мм.",
    },
    {
      key: "carbon_prof_slope_statement",
      role: "уклонообразующий слой CARBON PROF SLOPE",
      label: "ТЕХНОНИКОЛЬ CARBON PROF SLOPE",
      detected: roofStatementQuantities.carbonProfSlopeM3 > 0,
      searchTerms: ["CARBON PROF SLOPE", "ТЕХНОНИКОЛЬ CARBON PROF SLOPE", "CARBON PROF"],
      quantityType: "m3",
      reviewOnly: true,
      quantityOverride: roofStatementQuantities.carbonProfSlopeM3 > 0
        ? {
          value: roofStatementQuantities.carbonProfSlopeM3,
          unit: "m3",
          source: "Объем CARBON PROF SLOPE взят из ведомости материалов кровли.",
        }
        : undefined,
      note: "Ведомость дает объем уклонообразующего слоя; в счет ставить после сверки раскладки клиновидных элементов/марок SLOPE.",
    },
    {
      key: "logicpir_prof_ff_40_double",
      role: "теплоизоляция по Ж/Б, LOGICPIR",
      label: "LOGICPIR PROF Ф/Ф 40 мм, 2 слоя",
      detected: roofSpecAreas.membraneOnConcreteArea > 0 && /logicpir prof[\s\S]{0,80}?40\s*мм/i.test(lower),
      searchTerms: ["LOGICPIR PROF Ф/Ф 40", "LOGICPIR PROF 40", "LOGICPIR PROF Ф/Ф Г1 40"],
      factor: 1.03,
      thicknessMm: 40,
      areaOverride: roofSpecAreas.membraneOnConcreteArea * 2,
      quantityType: "m3",
      note: "В спецификации по Ж/Б указаны два слоя LOGICPIR PROF Ф/Ф 40 мм; количество посчитано как два слоя по площади этого типа кровли.",
    },
    {
      key: "logicpir_prof_ff_70",
      role: "теплоизоляция по профлисту, LOGICPIR",
      label: "LOGICPIR PROF Ф/Ф 70 мм",
      detected: roofSpecAreas.membraneOnProfiledSheetArea > 0 && /logicpir prof[\s\S]{0,80}?70\s*мм/i.test(lower),
      searchTerms: ["LOGICPIR PROF Ф/Ф 70", "LOGICPIR PROF 70", "LOGICPIR PROF Ф/Ф Г1 70"],
      factor: 1.03,
      thicknessMm: 70,
      areaOverride: roofSpecAreas.membraneOnProfiledSheetArea,
      quantityType: "m3",
      note: "Слой относится к типу кровли по профлисту; площадь взята из спецификации кровельного покрытия.",
    },
    ...roofWoolLayersWithStatementQuantities,
    {
      key: "technoruf_n_prof_100_spec",
      role: "теплоизоляция по профлисту, каменная вата",
      label: "ТЕХНОРУФ Н ПРОФ 100 мм",
      detected: roofSpecAreas.membraneOnProfiledSheetArea > 0 && /техноруф н проф[\s\S]{0,80}?100\s*мм/i.test(lower),
      searchTerms: ["ТЕХНОРУФ Н ПРОФ 100", "ТЕХНОРУФ Н 30 100", "ТЕХНОРУФ Н ПРОФ"],
      factor: 1.03,
      thicknessMm: 100,
      areaOverride: roofSpecAreas.membraneOnProfiledSheetArea,
      quantityType: "m3",
      note: "Слой относится к типу кровли по профлисту; конкретную марку ТЕХНОРУФ Н ПРОФ сверить по ведомости.",
    },
    {
      key: "logicpir_slope",
      role: "уклонообразующий слой LOGICPIR SLOPE",
      label: "LOGICPIR SLOPE",
      detected: includesAny(lower, [/logicpir slope/i]),
      searchTerms: [],
      quantityType: "project",
      projectOnly: true,
      note: "Количество клиновидных плит LOGICPIR SLOPE считать по плану уклонов/раскладке элементов, не по общей площади.",
    },
    {
      key: "technobarrier_concrete_spec",
      role: "пароизоляция по Ж/Б основанию",
      label: "ТЕХНОБАРЬЕР",
      detected: hasSegmentedVaporBarrierSpec && roofSpecAreas.membraneOnConcreteArea > 0,
      searchTerms: ["ТЕХНОБАРЬЕР"],
      factor: 1.12,
      areaOverride: roofSpecAreas.membraneOnConcreteArea || undefined,
      quantityType: "m2",
      note: "Слой относится к типу кровли по Ж/Б основанию; площадь взята из спецификации кровельного покрытия.",
    },
    {
      key: "parobarrier_profile_spec",
      role: "пароизоляция по профлисту",
      label: hasParobarrierCa500 ? "Паробарьер СА500" : "Паробарьер C",
      detected: hasSegmentedVaporBarrierSpec && roofSpecAreas.membraneOnProfiledSheetArea > 0,
      searchTerms: hasParobarrierCa500
        ? ["Паробарьер СА 500", "Паробарьер СА500", "Паробарьер"]
        : ["Паробарьер С", "Паробарьер C", "Паробарьер"],
      factor: 1.12,
      areaOverride: roofSpecAreas.membraneOnProfiledSheetArea || undefined,
      quantityType: "m2",
      note: "Слой относится к типу кровли по профлисту; площадь взята из спецификации кровельного покрытия.",
    },
    {
      key: "technobarrier",
      role: "пароизоляция",
      label: hasParobarrierCa500
        ? "Паробарьер СА500"
        : hasParobarrierC && !hasTechnobarrier
          ? "Паробарьер C"
          : hasTechnobarrier && !hasParobarrierC
            ? "ТЕХНОБАРЬЕР"
            : "ТЕХНОБАРЬЕР / Паробарьер C",
      detected: !hasSegmentedVaporBarrierSpec && includesAny(lower, [/технобарьер/i, /паробарьер\s*с/i, /паробарьер\s*[сc][аa]\s*500/i]),
      searchTerms: hasParobarrierCa500
        ? ["Паробарьер СА 500", "Паробарьер СА500", "Паробарьер"]
        : hasParobarrierC && !hasTechnobarrier
          ? ["Паробарьер С", "Паробарьер C", "Паробарьер"]
          : hasTechnobarrier && !hasParobarrierC
            ? ["ТЕХНОБАРЬЕР"]
            : ["ТЕХНОБАРЬЕР", "Паробарьер С", "Паробарьер C", "Паробарьер"],
      factor: 1.12,
      areaOverride: mainPvcMembraneArea,
      quantityOverride: roofStatementQuantities.parobarrierCa500M2 > 0
        ? {
          value: roofStatementQuantities.parobarrierCa500M2,
          unit: "m2",
          source: "Количество Паробарьер СА500 взято из ведомости материалов кровли.",
        }
        : undefined,
      quantityType: "m2",
      reviewOnly: hasSegmentedVaporBarrierSpec,
      note: hasParobarrierCa500
        ? "В проекте найден Паробарьер СА500; количество посчитано по основной площади ПВХ-мембраны, перед КП сверить по узлам и нахлестам."
        : hasSegmentedVaporBarrierSpec
          ? "В проекте есть разные пароизоляции для разных оснований; вместо общей строки используются отдельные слои по Ж/Б и профлисту."
        : hasParobarrierC && !hasTechnobarrier
          ? "В проекте найден Паробарьер C; перед КП сверить точную модификацию и ширину рулона."
          : hasTechnobarrier && !hasParobarrierC
            ? "В проекте найден ТЕХНОБАРЬЕР; перед КП сверить точную модификацию."
            : "Марку пароизоляции сверить: в разных местах проекта указаны ТЕХНОБАРЬЕР и Паробарьер C.",
    },
    {
      key: "hydrowind_membrane",
      role: "гидроветрозащитная мембрана",
      label: "Гидроветрозащитная мембрана",
      detected: includesAny(lower, [/гидро\s*ветрозащитн[а-я\s-]*мембран/i, /гидроветрозащитн[а-я\s-]*мембран/i]),
      searchTerms: hasExactHydrowindMembrane
        ? ["Гидроветрозащитная мембрана", "Гидро-ветрозащитная мембрана", "Ветрозащитная мембрана"]
        : [],
      factor: 1.15,
      quantityType: "m2",
      note: hasExactHydrowindMembrane
        ? "Тип мембраны и допустимость применения в кровельном пироге сверить по проекту/системе."
        : "В проекте указана общая гидроветрозащитная мембрана без марки; конкретный код 1С в счет не ставить без уточнения типа мембраны.",
    },
    {
      key: "profiled_sheet_n57",
      role: "несущее основание/профлист",
      label: "Стальной профлист Н57",
      detected: includesAny(lower, [/стальн[а-я\s-]*профлист\s*н\s*57/i, /профлист\s*н\s*57/i]),
      searchTerms: [],
      quantityType: "project",
      projectOnly: true,
      note: "Профлист Н57 считать по КМ/КМД или ведомости профлиста; по площади кровли автоматически в счет не ставить.",
    },
    {
      key: "profiled_sheet_n114",
      role: "несущее основание/профлист кровли",
      label: "Профилированный лист Н114-750-1,0",
      detected: includesAny(lower, [/профилированн[а-я\s-]*лист[\s\S]{0,60}н\s*114[\s\S]{0,40}750[\s\S]{0,20}1[,.]0/i, /н114-750-1[,.]0/i]),
      searchTerms: [],
      quantityType: "project",
      projectOnly: true,
      note: "Профлист Н114-750-1,0 указан как основание кровли; считать по разделу КМ/КМД и ведомости профлиста, не по общей площади мембраны.",
    },
    {
      key: "profiled_sheet_c21",
      role: "доборное основание/профлист узлов",
      label: "Профилированный лист C21-1000-0,6",
      detected: includesAny(lower, [/профилированн[а-я\s-]*лист[\s\S]{0,60}[сc]\s*21[\s\S]{0,40}1000[\s\S]{0,20}0[,.]6/i, /[сc]\s*21-1000-0[,.]6/i]),
      searchTerms: [],
      quantityType: "project",
      projectOnly: true,
      note: "Профлист C21-1000-0,6 найден в узле/разделе КМ; количество брать из КМ/раскладки, не из площади кровли.",
    },
    {
      key: "roof_sandwich_panel_100",
      role: "кровельные сэндвич-панели",
      label: roofSpecAreas.sandwichRoofArea > 0 ? `Кровельные сэндвич-панели 100 мм, ${roofSpecAreas.sandwichRoofArea} м2` : "Кровельные сэндвич-панели 100 мм",
      detected: roofSpecAreas.sandwichRoofArea > 0,
      searchTerms: [],
      quantityType: "project",
      projectOnly: true,
      note: "Отдельный тип кровли по спецификации. В счет ставить только после подбора производителя/замены и кода 1С по сэндвич-панелям.",
    },
    {
      key: "primer_08",
      role: "грунтовка основания",
      label: "Праймер №08",
      detected: includesAny(lower, [/праймер\s*(?:№|n)?\s*0?8/i, /грунтовка\s+праймер/i]),
      searchTerms: ["Праймер 08", "Праймер ТЕХНОНИКОЛЬ 08", "Праймер №08"],
      quantityType: "project",
      note: "Расход праймера зависит от основания; в счет ставить после проверки нормы проекта.",
    },
    {
      key: "uniflex_epp",
      role: "пароизоляция",
      label: "Унифлекс ЭПП",
      detected: includesAny(lower, [/унифлекс\s+эпп/i]),
      searchTerms: ["Унифлекс ЭПП"],
      factor: 1.15,
      quantityType: "m2",
    },
    {
      key: "xps",
      role: "теплоизоляция",
      label: xpsThicknessMm ? `${hasCarbonProf ? "CARBON PROF" : "XPS"} ${xpsThicknessMm} мм` : hasCarbonProf ? "CARBON PROF" : "XPS",
      detected: includesAny(lower, [/xps/i, /эппс/i]) ||
        (roofStatementQuantities.carbonProfSlopeM3 <= 0 && includesAny(lower, [/экструдированн[а-я\s-]*пенополистирол/i, /экструзионн[а-я\s-]*пенополистирол/i])) ||
        (hasPlainCarbonProf && !hasCarbonProfSlope),
      searchTerms: xpsThicknessMm
        ? hasCarbonProf
          ? [`CARBON PROF ${xpsThicknessMm}`, `ТЕХНОНИКОЛЬ CARBON PROF ${xpsThicknessMm}`, `CARBON PROF`, `XPS ${xpsThicknessMm}`, `ЭППС ${xpsThicknessMm}`]
          : [`CARBON ECO ${xpsThicknessMm}`, `CARBON PROF ${xpsThicknessMm}`, `XPS ${xpsThicknessMm}`, `ЭППС ${xpsThicknessMm}`]
        : hasCarbonProf
          ? ["CARBON PROF", "ТЕХНОНИКОЛЬ CARBON PROF", "XPS", "ЭППС"]
          : ["CARBON ECO", "CARBON PROF", "XPS", "ЭППС"],
      factor: 1.03,
      thicknessMm: xpsThicknessMm,
      quantityType: xpsThicknessMm ? "m3" : "m2",
      reviewOnly: hasSegmentedRoofSpec && !hasPlainCarbonProf,
      note: hasSegmentedRoofSpec && !hasPlainCarbonProf
        ? "XPS/экструзионный пенополистирол найден в проекте, но не входит в распознанный пирог мембранной кровли; в счет не ставить без проверки листа состава/ведомости."
        : undefined,
    },
    {
      key: "keramzit_slope",
      role: "уклонообразующий слой",
      label: keramzitAvg ? `Керамзитовый гравий, средняя толщина ${round(keramzitAvg, 1)} мм` : "Керамзитовый гравий",
      detected: includesAny(lower, [/разуклонк[а-я\s-]*керамзит/i, /керамзитн[а-я\s-]*грав/i]),
      searchTerms: ["Гравий керамзитовый", "Керамзит гравий", "Керамзитовый гравий"],
      thicknessMm: keramzitAvg,
      quantityType: keramzitAvg ? "m3" : "project",
      note: "Уклонку считать по проекту уклонов; средняя толщина из PDF дает только предварительный объем.",
    },
    {
      key: "cement_screed",
      role: "армированная/цементно-песчаная стяжка",
      label: "Цементно-песчаная стяжка 50 мм",
      detected: includesAny(lower, [/цементно-песчан[а-я\s-]*стяжк[а-я\s-]*50\s*мм/i, /цпс[а-я\s-]*50\s*мм/i]),
      searchTerms: ["Цементно-песчаная смесь", "ЦПС", "Пескобетон"],
      thicknessMm: 50,
      quantityType: "m3",
      note: "Если стяжка выполняется подрядчиком из песка/цемента, это проектный слой; сухую смесь ставить только если продаем как материал.",
    },
    {
      key: "pergamin",
      role: "разделительный слой",
      label: "Пергамин",
      detected: includesAny(lower, [/пергамин/i]),
      searchTerms: ["Пергамин"],
      factor: 1.15,
      quantityType: "m2",
    },
    {
      key: "technoelast_epp",
      role: "нижний слой кровельного ковра",
      label: "Техноэласт ЭПП",
      detected: includesAny(lower, [/техноэласт\s+эпп/i]),
      searchTerms: ["Техноэласт ЭПП"],
      factor: 1.15,
      quantityType: "m2",
    },
    {
      key: "technoelast_ekp",
      role: "верхний слой кровельного ковра",
      label: "Техноэласт ЭКП",
      detected: includesAny(lower, [/техноэласт\s+экп/i]),
      searchTerms: ["Техноэласт ЭКП"],
      factor: 1.15,
      quantityType: "m2",
    },
    {
      key: "rc_slab",
      role: "основание",
      label: "Монолитная ж/б плита 200 мм",
      detected: includesAny(lower, [/монолитн[а-я\s-]*ж\/?б\s+плит[а-я\s-]*200\s*мм/i]),
      searchTerms: [],
      quantityType: "project",
      projectOnly: true,
      note: "Конструктивное основание, в номенклатурный счет кровельных материалов не ставится.",
    },
    {
      key: "external_roof_drainage",
      role: "наружная водосточная система",
      label: "Водосточные желоба/водосборные воронки",
      detected: hasExternalRoofDrainage,
      searchTerms: [],
      quantityType: "project",
      note: "В проекте указан наружный организованный водосток; спецификацию желобов, водосборных воронок, труб и крепежа запросить у производителя/проектировщика. В счет без ведомости не ставить.",
    },
    {
      key: "roof_funnel_geberit_pluvia",
      role: "водоотвод/кровельная воронка",
      label: "Водосточная воронка Geberit Pluvia",
      detected: hasGeberitPluvia,
      searchTerms: [
        "Geberit Pluvia",
        "Воронка Geberit Pluvia",
        "Воронка ТехноНИКОЛЬ ВБ ЭКО",
        "Воронка ТехноНИКОЛЬ ЭКО с обжимным фланцем",
        "Воронка кровельная PLASTFOIL VORTEX",
        "Воронка кровельная PLASTFOIL VORTEX D=110",
        "Воронка кровельная PLASTFOIL VORTEX D=160",
        "Воронка кровельная WIGAR PRO 110",
        "Воронка кровельная WIGAR DN 110",
        "Воронка кровельная TERMOCLIP",
        "TERMOCLIP ВФО",
      ],
      quantityType: "project",
      unitCount: geberitPluviaUnitCount,
      note: "В проекте указана воронка Geberit Pluvia; основную позицию держать по проекту, аналоги ТЕХНОНИКОЛЬ/PLASTFOIL/WIGAR/TERMOCLIP предлагать только на согласование.",
    },
    {
      key: hasParapetFunnel ? "roof_funnel_parapet" : "roof_funnel",
      role: "водоотвод/кровельная воронка",
      label: hasSquareParapetFunnel ? "Воронка парапетная квадратного сечения с галтелью 100х100х600" : hasParapetFunnel ? "Воронка парапетная" : "Воронка кровельная",
      detected: !hasGeberitPluvia && (!hasExternalRoofDrainage || hasParapetFunnel) && includesAny(lower, [/воронк[а-я]*/i, /водосточн[а-я\s-]*воронк/i, /внутренн[а-я\s-]*водост/i]),
      searchTerms: hasParapetFunnel
        ? hasSquareParapetFunnel
          ? ["Воронка парапетная ТехноНИКОЛЬ квадратного сечения с галтелью 100*100*600", "Воронка парапетная ТехноНИКОЛЬ", "Воронка парапетная"]
          : ["Воронка парапетная ТехноНИКОЛЬ", "Воронка парапетная"]
        : ["Воронка ТехноНИКОЛЬ", "Воронка кровельная", "Воронка с обжимным фланцем"],
      quantityType: "project",
      unitCount: funnelUnitCount,
      note: roofDrainLabelCount
        ? `Количество воронок предварительно снято с обозначений ВВ/ВП на плане кровли: ${roofDrainLabelCount} шт. Перед КП сверить тип, диаметр, обогрев и схему водоотвода.`
        : hasInternalFunnelOnRoofPlan
        ? "Воронки внутреннего водостока указаны на плане/в примечаниях кровли. Количество нужно снять с графики плана кровли или ведомости; тип, диаметр, обогрев и совместимость с системой подтвердить перед КП."
        : "Количество и тип воронок считать по проекту или калькулятору NAV.TN; в счет ставить только после подтверждения водосборных участков.",
    },
  ];

  return layers.filter((layer) => layer.detected);
}

function shouldRunAiExtraction(input: {
  direction: string;
  question: string;
  area: AreaInfo;
  layers: DetectedLayer[];
}) {
  const mode = getProjectAiExtractorMode();
  if (mode === "off") return false;
  if (!hasProjectAiExtractorConfig()) return false;
  if (!/кров|roof/i.test(input.direction)) return false;
  if (mode === "always") return true;

  const questionAsksAi = /(^|\s)(ai|ии)(\s|$)|прочитай|распознай|извлеки/i.test(input.question);
  const weakArea = input.area.source === "not_found" || input.area.source === "axes_estimate" || input.area.confidence === "low";
  const weakLayers = input.layers.length < 2;
  const onlyProjectLayers = input.layers.length > 0 && input.layers.every((layer) => layer.projectOnly);
  const missingPvcThickness = input.layers.some((layer) => layer.key === "pvc_logicroof_vrp" && !layer.thicknessMm);

  return questionAsksAi || weakArea || weakLayers || onlyProjectLayers || missingPvcThickness;
}

function normalizeGroundingText(text: string | null | undefined) {
  return (text ?? "")
    .toLowerCase()
    .replace(/\u00a0/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasGroundedSnippet(pdfText: string, sourceText: string | null | undefined) {
  const source = normalizeGroundingText(sourceText);
  if (source.length < 12) return false;
  const pdf = normalizeGroundingText(pdfText);
  if (pdf.includes(source)) return true;
  const sourceWords = source.split(" ").filter((word) => word.length >= 4);
  if (sourceWords.length < 3) return false;
  return sourceWords.filter((word) => pdf.includes(word)).length >= Math.min(sourceWords.length, 6);
}

function hasPdfMaterialEvidence(layer: ProjectAiLayer, pdfText: string) {
  const pdf = normalizeGroundingText(pdfText);
  const layerText = normalizeGroundingText(`${layer.material ?? ""} ${layer.role ?? ""} ${layer.note ?? ""}`);
  if (!layerText) return false;

  const checks: Array<[RegExp, RegExp]> = [
    [/logicroof\s+v\s+rp|пвх\s+мембран|полимерн[а-я]*\s+мембран/, /logicroof\s+v\s+rp|пвх\s+мембран|полимерн[а-я]*\s+мембран/],
    [/logicpir/, /logicpir/],
    [/технор[уо]ф/, /технор[уо]ф/],
    [/xps|carbon|экструзион[а-я]*|пенополистирол/, /xps|carbon|экструзион[а-я]*|пенополистирол/],
    [/технобарьер|паробарьер|пароизоляц/, /технобарьер|паробарьер|пароизоляц/],
    [/гидро\s*ветрозащит|ветрозащит/, /гидро\s*ветрозащит|ветрозащит/],
    [/унифлекс/, /унифлекс/],
    [/техноэласт/, /техноэласт/],
    [/керамзит/, /керамзит/],
    [/пергамин/, /пергамин/],
    [/стяжк|цпс|цементно\s+песчан/, /стяжк|цпс|цементно\s+песчан/],
    [/воронк|водосток|водоотвод|желоб/, /воронк|водосток|водоотвод|желоб/],
    [/сэндвич|сендвич|профнастил|профлист|монолитн|железобетон/, /сэндвич|сендвич|профнастил|профлист|монолитн|железобетон/],
  ];

  return checks.some(([layerPattern, pdfPattern]) => layerPattern.test(layerText) && pdfPattern.test(pdf));
}

function layerMaterialTokens(layer: ProjectAiLayer) {
  return normalizeGroundingText(`${layer.material ?? ""} ${layer.role ?? ""}`)
    .split(" ")
    .filter((word) => word.length >= 4 && !/^\d+$/.test(word));
}

function isExactlyGroundedAiLayer(layer: ProjectAiLayer, pdfText: string) {
  if (!hasGroundedSnippet(pdfText, layer.sourceText)) return false;
  const source = normalizeGroundingText(layer.sourceText);
  const tokens = layerMaterialTokens(layer);
  if (!tokens.length) return false;
  return tokens.some((token) => source.includes(token));
}

function isGroundedAiLayer(layer: ProjectAiLayer, pdfText: string) {
  return isExactlyGroundedAiLayer(layer, pdfText) || hasPdfMaterialEvidence(layer, pdfText);
}

type SuccessfulProjectAiExtraction = Extract<ProjectAiExtraction, { status: "ok" }>;

function hasPdfAreaEvidence(areaM2: number, pdfText: string) {
  const pdf = normalizeGroundingText(pdfText);
  const areaNumber = String(Math.round(areaM2));
  const index = pdf.indexOf(areaNumber);
  if (index < 0) return false;
  const context = pdf.slice(Math.max(0, index - 120), Math.min(pdf.length, index + 120));
  return /кров|roof|покрыт|площад/.test(context);
}

function isGroundedAiArea(extraction: SuccessfulProjectAiExtraction, pdfText: string) {
  if (!extraction.roofAreaM2 || extraction.roofAreaM2 <= 0) return false;
  if (hasGroundedSnippet(pdfText, extraction.roofAreaSource)) {
    const source = normalizeGroundingText(extraction.roofAreaSource);
    const areaText = String(Math.round(extraction.roofAreaM2));
    const hasAreaNumber = source.includes(areaText) || source.includes(String(extraction.roofAreaM2).replace(".", " "));
    return hasAreaNumber && /кров|roof|покрыт|площад/.test(source);
  }
  return hasPdfAreaEvidence(extraction.roofAreaM2, pdfText);
}

function groundAiExtraction(extraction: ProjectAiExtraction, pdfText: string): ProjectAiExtraction {
  if (extraction.status !== "ok") return extraction;

  const layers = extraction.layers.filter((layer) => isGroundedAiLayer(layer, pdfText));
  const exactLayers = extraction.layers.filter((layer) => isExactlyGroundedAiLayer(layer, pdfText));
  const rejectedLayers = extraction.layers.length - layers.length;
  const looselyAcceptedLayers = layers.length - exactLayers.length;
  const groundedArea = isGroundedAiArea(extraction, pdfText);
  const warnings = [
    ...extraction.warnings,
    ...(rejectedLayers > 0 ? [`Rejected ${rejectedLayers} AI layer(s) without exact PDF grounding.`] : []),
    ...(looselyAcceptedLayers > 0 ? [`Accepted ${looselyAcceptedLayers} AI layer(s) by material evidence in PDF.`] : []),
    ...(!groundedArea && extraction.roofAreaM2 ? ["Rejected AI roof area without exact PDF grounding."] : []),
  ];

  return {
    ...extraction,
    roofAreaM2: groundedArea ? extraction.roofAreaM2 : null,
    roofAreaSource: groundedArea ? extraction.roofAreaSource : null,
    roofAreaConfidence: groundedArea ? extraction.roofAreaConfidence : "none",
    layers,
    warnings,
  };
}

function parseAiThickness(text: string) {
  const match = text.match(/(\d{1,3}(?:[,.]\d)?)\s*(?:мм|mm)/i);
  return match?.[1] ? toNumber(match[1]) : undefined;
}

function hasAiLayerAreaEvidence(layer: ProjectAiLayer) {
  if (!layer.areaM2 || layer.areaM2 <= 0) return false;
  const text = `${layer.sourceText ?? ""} ${layer.note ?? ""}`.replace(/\u00a0/g, " ");
  const areaMatches = Array.from(text.matchAll(/(\d{1,3}(?:\s+\d{3})+|\d+(?:[,.]\d+)?)\s*\*?\s*(?:м\s*2|м2|м²|кв\.?\s*м)/gi));
  return areaMatches.some((match) => {
    const value = match[1] ? toLooseNumber(match[1]) : NaN;
    if (!Number.isFinite(value)) return false;
    return Math.abs(value - layer.areaM2!) <= Math.max(1, layer.areaM2! * 0.02);
  });
}

function aiLayerArea(layer: ProjectAiLayer) {
  if (!layer.areaM2 || layer.areaM2 <= 0) return undefined;
  if (!hasAiLayerAreaEvidence(layer)) return undefined;
  const explicitLayerCount = layer.layerCount && layer.layerCount > 1 ? layer.layerCount : undefined;
  const text = `${layer.role ?? ""} ${layer.material ?? ""} ${layer.note ?? ""}`.toLowerCase();
  const inferredLayerCount = explicitLayerCount ?? (/2\s*сло/i.test(text) ? 2 : 1);
  return round(layer.areaM2 * inferredLayerCount, 2);
}

function aiLayerNote(layer: ProjectAiLayer) {
  const source = layer.sourceText ? ` Фрагмент: ${layer.sourceText}` : "";
  const note = layer.note ? ` ${layer.note}` : "";
  return `Найдено AI-экстрактором проекта; перед КП сверить по PDF.${note}${source}`;
}

function buildAiDetectedLayers(extraction: ProjectAiExtraction): DetectedLayer[] {
  if (extraction.status !== "ok") return [];

  return extraction.layers.map((layer, index): DetectedLayer | null => {
    const material = layer.material?.trim() || "";
    const role = layer.role?.trim() || "материал из проекта";
    const text = `${role} ${material} ${layer.sourceText ?? ""} ${layer.note ?? ""}`.toLowerCase();
    const thicknessMm = layer.thicknessMm ?? parseAiThickness(text);
    const areaOverride = aiLayerArea(layer);
    const note = aiLayerNote(layer);
    const isProjectOnly = Boolean(layer.projectOnly);
    const unitCount = (layer.unit === "шт" || layer.quantityType === "шт") && layer.quantity ? layer.quantity : undefined;

    if (/plastfoil|пластфойл/.test(text)) {
      const isArt = /\bart\b|®\s*art|неармирован/i.test(text);
      const thicknessRu = thicknessMm ? String(thicknessMm).replace(".", ",") : "";
      return {
        key: isArt ? `pvc_plastfoil_art_ai_${index}` : `pvc_plastfoil_classic_ai_${index}`,
        role: isArt ? "дополнительная неармированная ПВХ-мембрана для примыканий" : "кровельная ПВХ-мембрана",
        label: `${isArt ? "Plastfoil Art" : "Plastfoil Classic"}${thicknessRu ? ` ${thicknessRu} мм` : ""}`,
        detected: true,
        searchTerms: [
          `${isArt ? "PLASTFOIL ART" : "PLASTFOIL classic"} ${thicknessRu}`.trim(),
          isArt ? "PLASTFOIL ART" : "PLASTFOIL classic",
          material,
        ].filter(Boolean),
        factor: 1.15,
        thicknessMm,
        areaOverride,
        quantityType: "m2",
        note,
      };
    }

    if (/logicroof\s+v-rp|пвх[а-я\s-]*мембран/.test(text)) {
      const isFr = /v[-\s]*rp\s*fr/i.test(text);
      return {
        key: "pvc_logicroof_vrp",
        role: "кровельная ПВХ-мембрана",
        label: thicknessMm ? `LOGICROOF V-RP${isFr ? " FR" : ""} ${thicknessMm} мм` : material || `LOGICROOF V-RP${isFr ? " FR" : ""}`,
        detected: true,
        searchTerms: thicknessMm
          ? [
            `Logicroof V-RP${isFr ? " FR" : ""} ${String(thicknessMm).replace(".", ",")}`,
            `Logicroof V-RP${isFr ? " FR" : ""} ${thicknessMm}`,
            "ПВХ Logicroof V-RP",
          ]
          : ["ПВХ Logicroof V-RP", "Logicroof V-RP"],
        factor: 1.15,
        thicknessMm,
        areaOverride,
        quantityType: "m2",
        note,
      };
    }

    if (/стеклохолст/.test(text)) {
      return {
        key: `ai_glass_fleece_100_${index}`,
        role: "разделительный слой",
        label: thicknessMm ? `Стеклохолст ${thicknessMm} г/м2` : material || "Стеклохолст",
        detected: true,
        searchTerms: ["Стеклохолст ТехноНИКОЛЬ 100", "Стеклохолст 100", material].filter(Boolean),
        factor: 1.18,
        areaOverride,
        quantityType: "m2",
        note,
      };
    }

    if (/isover|изовер|dirock|дирок|минераловатн[а-я\s-]*(?:ват|утеплител)|руф\s*[вн]/i.test(text)) {
      const isUpper = /руф\s*в|ruf\s*v|верхн/i.test(text);
      const label = thicknessMm ? `${material || "Минераловатный утеплитель кровли"} ${thicknessMm} мм` : material || "Минераловатный утеплитель кровли";
      return {
        key: `ai_roof_mw_${isUpper ? "upper" : "lower"}_${thicknessMm ?? "unknown"}_${index}`,
        role: isUpper ? "верхний слой минераловатного утепления кровли" : "нижний слой минераловатного утепления кровли",
        label,
        detected: true,
        searchTerms: [label, material].filter(Boolean),
        factor: 1.03,
        thicknessMm,
        areaOverride,
        quantityType: thicknessMm ? "m3" : "m2",
        reviewOnly: true,
        note: `${note} Проектный бренд/марку не заменять автоматически; предложить аналог из нашей базы только на согласование.`,
      };
    }

    if (/logicpir\s+slope/.test(text)) {
      return {
        key: `ai_logicpir_slope_${index}`,
        role: "уклонообразующий слой LOGICPIR SLOPE",
        label: material || "LOGICPIR SLOPE",
        detected: true,
        searchTerms: [],
        quantityType: "project",
        projectOnly: true,
        note: "Количество клиновидных плит LOGICPIR SLOPE считать по плану уклонов/раскладке элементов, не по общей площади.",
      };
    }

    if (/logicpir\s+prof/.test(text)) {
      return {
        key: `ai_logicpir_prof_${thicknessMm ?? "unknown"}_${index}`,
        role: role.includes("тепло") ? role : "теплоизоляция LOGICPIR",
        label: thicknessMm ? `LOGICPIR PROF Ф/Ф ${thicknessMm} мм` : material || "LOGICPIR PROF",
        detected: true,
        searchTerms: thicknessMm
          ? [`LOGICPIR PROF Ф/Ф ${thicknessMm}`, `LOGICPIR PROF ${thicknessMm}`, material].filter(Boolean)
          : ["LOGICPIR PROF Ф/Ф", "LOGICPIR PROF", material].filter(Boolean),
        factor: 1.03,
        thicknessMm,
        areaOverride,
        quantityType: thicknessMm ? "m3" : "m2",
        note,
      };
    }

    if (/технор[уо]ф/.test(text)) {
      const searchBase = material || role;
      return {
        key: `ai_technoruf_${thicknessMm ?? "unknown"}_${index}`,
        role: role.includes("тепло") ? role : "теплоизоляция кровли",
        label: thicknessMm ? `${material || "ТЕХНОРУФ"} ${thicknessMm} мм` : material || "ТЕХНОРУФ",
        detected: true,
        searchTerms: thicknessMm
          ? [`${searchBase} ${thicknessMm}`, `ТЕХНОРУФ ${thicknessMm}`, searchBase].filter(Boolean)
          : [searchBase, "ТЕХНОРУФ"].filter(Boolean),
        factor: 1.03,
        thicknessMm,
        areaOverride,
        quantityType: thicknessMm ? "m3" : "m2",
        note,
      };
    }

    if (/технобарьер|паробарьер/.test(text)) {
      return {
        key: "technobarrier",
        role: "пароизоляция",
        label: material || "ТЕХНОБАРЬЕР / Паробарьер",
        detected: true,
        searchTerms: ["ТЕХНОБАРЬЕР", "Паробарьер C", "Паробарьер", material].filter(Boolean),
        factor: 1.12,
        areaOverride,
        quantityType: "m2",
        note,
      };
    }

    if (/унифлекс\s+эпп/.test(text)) {
      return {
        key: "uniflex_epp",
        role: "пароизоляция",
        label: "Унифлекс ЭПП",
        detected: true,
        searchTerms: ["Унифлекс ЭПП"],
        factor: 1.15,
        areaOverride,
        quantityType: "m2",
        note,
      };
    }

    if (/техноэласт\s+эпп/.test(text)) {
      return {
        key: "technoelast_epp",
        role: "нижний слой кровельного ковра",
        label: "Техноэласт ЭПП",
        detected: true,
        searchTerms: ["Техноэласт ЭПП"],
        factor: 1.15,
        areaOverride,
        quantityType: "m2",
        note,
      };
    }

    if (/техноэласт\s+экп/.test(text)) {
      return {
        key: "technoelast_ekp",
        role: "верхний слой кровельного ковра",
        label: "Техноэласт ЭКП",
        detected: true,
        searchTerms: ["Техноэласт ЭКП"],
        factor: 1.15,
        areaOverride,
        quantityType: "m2",
        note,
      };
    }

    if (/пергамин/.test(text)) {
      return {
        key: "pergamin",
        role: "разделительный слой",
        label: "Пергамин",
        detected: true,
        searchTerms: ["Пергамин"],
        factor: 1.15,
        areaOverride,
        quantityType: "m2",
        note,
      };
    }

    if (/праймер|грунтовк/.test(text)) {
      return {
        key: "primer_08",
        role: "грунтовка основания",
        label: /0?8|№08|n08/i.test(text) ? "Праймер №08" : material || "Праймер",
        detected: true,
        searchTerms: ["Праймер 08", "Праймер ТЕХНОНИКОЛЬ 08", material].filter(Boolean),
        quantityType: "project",
        note,
      };
    }

    if (/xps|эппс|carbon|экструдированн[а-я\s-]*пенополистирол/.test(text)) {
      return {
        key: `ai_xps_${thicknessMm ?? "unknown"}_${index}`,
        role: "теплоизоляция",
        label: thicknessMm ? `${material || "XPS"} ${thicknessMm} мм` : material || "XPS",
        detected: true,
        searchTerms: thicknessMm
          ? [`CARBON ECO ${thicknessMm}`, `CARBON PROF ${thicknessMm}`, `XPS ${thicknessMm}`, material].filter(Boolean)
          : ["CARBON ECO", "CARBON PROF", "XPS", material].filter(Boolean),
        factor: 1.03,
        thicknessMm,
        areaOverride,
        quantityType: thicknessMm ? "m3" : "m2",
        note,
      };
    }

    if (/воронк/.test(text)) {
      const isParapet = /парапет/.test(text);
      return {
        key: isParapet ? `roof_funnel_parapet_ai_${index}` : `roof_funnel_ai_${index}`,
        role: isParapet ? "водоотвод/парапетная воронка" : "водоотвод/кровельная воронка",
        label: material || (isParapet ? "Воронка парапетная" : "Воронка кровельная"),
        detected: true,
        searchTerms: isParapet
          ? ["Воронка парапетная ТехноНИКОЛЬ", "Воронка парапетная", material].filter(Boolean)
          : ["Воронка ТехноНИКОЛЬ", "Воронка кровельная", material].filter(Boolean),
        quantityType: "project",
        unitCount,
        note,
      };
    }

    if (isProjectOnly || /logicpir\s+slope|сэндвич|сендвич|профлист|основан|ж\/?б|водосточн[а-я\s-]*желоб|наружн[а-я\s-]*водосток/.test(text)) {
      return {
        key: `ai_project_only_${index}`,
        role,
        label: material || role,
        detected: true,
        searchTerms: [],
        quantityType: "project",
        projectOnly: true,
        note,
      };
    }

    return null;
  }).filter((layer): layer is DetectedLayer => layer !== null);
}

function layerFamily(layer: DetectedLayer) {
  const key = layer.key.toLowerCase();
  const text = `${layer.role} ${layer.label}`.toLowerCase();

  if (key === "pvc_logicroof_vrp") return "pvc_logicroof_vrp";
  if (key.includes("pvc_plastfoil_classic") || text.includes("plastfoil classic")) return "pvc_plastfoil_classic";
  if (key.includes("pvc_plastfoil_art") || text.includes("plastfoil art")) return "pvc_plastfoil_art";
  if (key === "technobarrier") return "technobarrier";
  if (key === "uniflex_epp") return "uniflex_epp";
  if (key === "technoelast_epp") return "technoelast_epp";
  if (key === "technoelast_ekp") return "technoelast_ekp";
  if (key === "pergamin") return "pergamin";
  if (key === "primer_08") return "primer_08";
  if (key.includes("logicpir_slope") || text.includes("logicpir slope")) return "logicpir_slope";
  if (key.includes("glass_fleece") || text.includes("стеклохолст")) return "glass_fleece";
  if (key.includes("roof_funnel") || text.includes("воронк")) return "roof_funnel";
  if (key.includes("logicpir_prof") || text.includes("logicpir prof")) return `logicpir_prof_${layer.thicknessMm ?? parseAiThickness(text) ?? "unknown"}`;
  if (key.includes("technoruf") || text.includes("техноруф")) return `technoruf_${layer.thicknessMm ?? parseAiThickness(text) ?? "unknown"}`;
  if (key.includes("roof_mw") || text.includes("isover") || text.includes("изовер") || text.includes("dirock") || text.includes("дирок") || text.includes("минераловатн")) return `roof_mw_${layer.thicknessMm ?? parseAiThickness(text) ?? "unknown"}_${isUpperRoofWoolLayer(layer) ? "upper" : "lower"}`;
  if (key.includes("xps") || text.includes("xps") || text.includes("carbon")) return `xps_${layer.thicknessMm ?? parseAiThickness(text) ?? "unknown"}`;

  return null;
}

function isCountableLayer(layer: DetectedLayer) {
  return !layer.projectOnly && layer.quantityType !== "project" && layer.searchTerms.length > 0;
}

function mergeDetectedLayers(baseLayers: DetectedLayer[], aiLayers: DetectedLayer[]) {
  const merged = new Map<string, DetectedLayer>();
  for (const layer of baseLayers) merged.set(layer.key, layer);
  const baseFamilies = new Set(baseLayers.map(layerFamily).filter((family): family is string => Boolean(family)));
  const hasStrongBaseline = baseLayers.filter(isCountableLayer).length >= 2;

  for (const aiLayer of aiLayers) {
    const existing = merged.get(aiLayer.key);
    if (!existing) {
      const family = layerFamily(aiLayer);
      if (family && baseFamilies.has(family)) continue;

      const isUnsafeAiOnlyCalculation =
        hasStrongBaseline &&
        aiLayer.key.startsWith("ai_") &&
        isCountableLayer(aiLayer) &&
        !aiLayer.areaOverride &&
        !aiLayer.unitCount;
      if (isUnsafeAiOnlyCalculation) continue;

      merged.set(aiLayer.key, aiLayer);
      if (family) baseFamilies.add(family);
      continue;
    }

    merged.set(aiLayer.key, {
      ...existing,
      label: existing.thicknessMm ? existing.label : aiLayer.label || existing.label,
      searchTerms: existing.searchTerms.length ? existing.searchTerms : aiLayer.searchTerms,
      thicknessMm: existing.thicknessMm ?? aiLayer.thicknessMm,
      areaOverride: existing.areaOverride ?? aiLayer.areaOverride,
      quantityOverride: existing.quantityOverride ?? aiLayer.quantityOverride,
      unitCount: existing.unitCount ?? aiLayer.unitCount,
      note: existing.note ?? aiLayer.note,
    });
  }
  return Array.from(merged.values());
}

function mainRoofMembraneAreaFromLayers(layers: DetectedLayer[]) {
  const mainMembrane = layers.find((layer) =>
    ["pvc_logicroof_vrp", "pvc_plastfoil_classic"].includes(layer.key) &&
    ((layer.areaOverride && layer.areaOverride > 0) || (layer.quantityOverride?.unit === "m2" && layer.quantityOverride.value > 0))
  );
  return mainMembrane?.areaOverride ?? mainMembrane?.quantityOverride?.value ?? null;
}

function buildRoofFastenerGuidance(text: string, question: string) {
  const signalText = `${text} ${question}`.toLowerCase();
  const asksAboutFasteners = /креп[её]ж|саморез|телескоп|termoclip|термоклип|анкер/i.test(signalText);
  const looksLikeMechanicallyFixedRoof = /пвх|logicroof|мембран|механическ/i.test(signalText) && /кровл|профлист|основан|утепл/i.test(signalText);
  const shouldMention = asksAboutFasteners || looksLikeMechanicallyFixedRoof;

  return {
    shouldMention,
    source: "правило из консультации специалиста, обновлено 2026-05-28",
    scope: "механическое крепление мембраны/утеплителя в кровельных системах",
    rules: [
      "Крепеж подбирается по общей толщине теплоизоляции и типу основания.",
      "Комплект для мембраны: телескопический крепеж + саморез; для бетонного основания дополнительно нужен нейлоновый дюбель/анкерный элемент.",
      "Для профлиста применяется сверлоконечный саморез; для бетона — остроконечный саморез в дюбель/анкер после засверливания.",
      "Пример из консультации: при 150 мм утепления нужен телескопический крепеж 120 мм и саморез 70 мм.",
      "Основное поле мембраны: предварительный ориентир 4 комплекта/м2, то есть 4 телескопа + 4 самореза на м2.",
      "Предварительное крепление теплоизоляции: минимум 2 крепежа/м2.",
      "Предварительный полный ориентир для поля: 6 крепежных комплектов/м2, но не как финальный ветровой расчет.",
      "Краевые, периметральные и угловые ветровые зоны рассчитываются отдельно и могут требовать больше крепежа.",
    ],
    preliminaryRates: {
      insulationFastenersPerM2: 2,
      membraneFieldKitsPerM2: 4,
      totalFieldFastenersPerM2: 6,
    },
  };
}

function buildRoofDrainGuidance(text: string, question: string, layers: DetectedLayer[]) {
  const signalText = `${text} ${question}`.toLowerCase();
  const hasExternalRoofDrainage = /наружн[а-я\s-]*организованн[а-я\s-]*водосток|водосточн[а-я\s-]*желоб|водосборн[а-я\s-]*воронк/i.test(text.toLowerCase());
  const detectedInText = !hasExternalRoofDrainage && /воронк|водосточн[а-я\s-]*воронк|внутренн[а-я\s-]*водост/i.test(text.toLowerCase());
  const asksAboutDrains = /воронк|водосток|водоотвод|ливнев/i.test(signalText);
  const looksLikeFlatRoof = layers.some((layer) =>
    ["uniflex_epp", "technoelast_epp", "technoelast_ekp", "keramzit_slope", "pergamin"].includes(layer.key)
  );

  return {
    shouldMention: !hasExternalRoofDrainage && (asksAboutDrains || looksLikeFlatRoof),
    detectedInText,
    calculatorUrl: "https://nav.tn.ru/calculators/calc-funnel/",
    source: "NAV.TN, калькулятор расчета количества кровельных воронок",
    rules: [
      "Количество воронок нельзя считать только по общей площади кровли: нужен водосборный участок, населенный пункт/интенсивность дождя, тип воронки и схема водоотвода.",
      "Если воронки есть в проекте или ведомости, ставить в счет найденный тип и количество с кодом 1С.",
      "Если в PDF воронки не найдены, для плоской кровли обязательно вынести в уточнение: проверить внутренний/парапетный водоотвод и посчитать через проект или калькулятор NAV.TN.",
    ],
    searchTerms: [
      "Воронка ТехноНИКОЛЬ",
      "Воронка парапетная ТехноНИКОЛЬ",
      "Воронка с обжимным фланцем",
      "Воронка ремонтная ТехноНИКОЛЬ",
    ],
  };
}

function buildSearchPattern(term: string) {
  return `%${term.trim().replace(/\s+/g, "%")}%`;
}

function itemScore(item: NomenclatureItem, layer: DetectedLayer) {
  const name = (item.name ?? "").toLowerCase();
  const brand = (item.brand ?? "").toLowerCase();
  const requested = layer.label.toLowerCase();
  let score = 0;
  if (item.code) score += 10;
  if (brand.includes("технониколь")) score += 4;
  if (name.includes("технониколь")) score += 3;
  if (/технониколь|carbon|техноэласт|унифлекс/i.test(item.name ?? "")) score += 4;
  if (layer.thicknessMm && name.includes(String(layer.thicknessMm))) score += 6;
  if (layer.key.includes("epp") && /эпп/i.test(item.name ?? "")) score += 10;
  if (layer.key.includes("ekp") && /экп/i.test(item.name ?? "")) score += 10;
  if (layer.key === "primer_08" && /0?8|№08|n08/i.test(item.name ?? "")) score += 12;
  if (layer.key === "pvc_logicroof_vrp" && /logicroof/i.test(item.name ?? "") && /v-rp/i.test(item.name ?? "")) score += 16;
  if (layer.key === "pvc_logicroof_vrp" && /v[-\s]*rp\s*fr|\bfr\b/i.test(requested)) {
    if (/v[-\s]*rp\s*fr|\bfr\b/i.test(item.name ?? "")) score += 40;
    else if (/v[-\s]*rp/i.test(item.name ?? "")) score -= 25;
  }
  if (layer.key === "pvc_logicroof_vrp" && layer.thicknessMm) {
    const desiredThickness = String(layer.thicknessMm).replace(".", "[,.]");
    const hasDesiredThickness = new RegExp(`${desiredThickness}\\s*(?:мм|mm)?`).test(name);
    const itemThickness = name.match(/(?:^|\s)(1[,.][258]|2[,.]0)\s*(?:мм|mm)?/i)?.[1]?.replace(",", ".");
    if (hasDesiredThickness) score += 30;
    if (itemThickness && itemThickness !== String(layer.thicknessMm)) score -= 20;
  }
  if (layer.key === "pvc_logicroof_vrp" && /arctic|arctiс/i.test(item.name ?? "") && !/arctic|arctiс/i.test(requested)) score -= 20;
  if (layer.key === "pvc_logicroof_vrp" && /2[,.]10\s*[xх]\s*20/i.test(item.name ?? "")) score += 4;
  if (layer.key.startsWith("pvc_plastfoil_classic") && /plastfoil|пластфойл/i.test(item.name ?? "")) score += 18;
  if (layer.key.startsWith("pvc_plastfoil_classic") && /classic|classi[сc]/i.test(item.name ?? "")) score += 16;
  if (layer.key.startsWith("pvc_plastfoil_classic") && layer.thicknessMm) {
    const desiredThickness = String(layer.thicknessMm).replace(".", "[,.]");
    const hasDesiredThickness = new RegExp(`${desiredThickness}\\s*(?:мм|mm)?|\\(${desiredThickness}\\s*[xх*]`).test(name);
    const itemThickness = name.match(/(?:^|\s|\()(1[,.][258]|2[,.]0|2)\s*(?:мм|mm|[xх*])?/i)?.[1]?.replace(",", ".");
    if (hasDesiredThickness) score += 34;
    if (itemThickness && itemThickness !== String(layer.thicknessMm)) score -= 80;
  } else if (layer.key.startsWith("pvc_plastfoil_classic") && /1[,.]2/i.test(item.name ?? "")) {
    score += 24;
  }
  if (layer.key.startsWith("pvc_plastfoil_classic") && /eco|geo|polar|light|art|lay/i.test(item.name ?? "")) score -= 12;
  if (layer.key.startsWith("pvc_plastfoil_art") && /plastfoil|пластфойл/i.test(item.name ?? "")) score += 18;
  if (layer.key.startsWith("pvc_plastfoil_art") && /\bart\b|®\s*art/i.test(item.name ?? "")) score += 22;
  if (layer.key.startsWith("pvc_plastfoil_art") && /неармирован/i.test(item.name ?? "")) score += 8;
  if (layer.key.startsWith("pvc_plastfoil_art") && /1[,.]5/i.test(item.name ?? "")) score += 18;
  if (layer.key.startsWith("pvc_plastfoil_art") && /40\s*м2|2000\s*[xх*]\s*20000/i.test(item.name ?? "")) score += 5;
  if (layer.key.startsWith("pvc_plastfoil_art") && /classic|eco|geo|polar|light|lay/i.test(item.name ?? "")) score -= 12;
  if (layer.key === "xps" && /carbon\s+prof/i.test(requested)) {
    if (/carbon\s+prof/i.test(item.name ?? "")) score += 24;
    if (/carbon\s+eco/i.test(item.name ?? "")) score -= 20;
  } else {
    if (layer.key === "xps" && /carbon eco/i.test(item.name ?? "")) score += 7;
    if (layer.key === "xps" && /carbon prof/i.test(item.name ?? "")) score += 5;
  }
  if (layer.key.startsWith("logicpir_prof") && /logicpir/i.test(item.name ?? "") && /prof/i.test(item.name ?? "")) score += 16;
  if (layer.key.startsWith("logicpir_prof") && /ф\/ф|f\/f/i.test(item.name ?? "")) score += 8;
  if (layer.key.includes("_40") && /40\b|40\s*мм/i.test(item.name ?? "")) score += 10;
  if (layer.key.includes("_70") && /70\b|70\s*мм/i.test(item.name ?? "")) score += 10;
  if (layer.key === "carbon_prof_slope_statement" && /carbon\s+prof\s+slope|карбон\s+проф\s+slope/i.test(item.name ?? "")) score += 28;
  if (layer.key === "carbon_prof_slope_statement" && !/slope|клин/i.test(item.name ?? "")) score -= 16;
  if (layer.key === "geotextile_tn_300_statement" && /геотекстил/i.test(item.name ?? "")) score += 18;
  if (layer.key === "geotextile_tn_300_statement" && /300/i.test(item.name ?? "")) score += 12;
  if (layer.key === "technobarrier" && /технобарьер|паробарьер/i.test(item.name ?? "")) score += 14;
  if (layer.key === "technobarrier" && /[сc][аa]\s*500/i.test(requested) && /[сc][аa]\s*500/i.test(name)) score += 20;
  if (layer.key === "technobarrier" && /[сc][аa]\s*500/i.test(requested) && /технобарьер/i.test(name)) score -= 10;
  if (layer.key === "technoruf_n_prof_100_spec" && /технор[уо]ф/i.test(item.name ?? "")) score += 14;
  if (layer.key === "technoruf_n_prof_100_spec" && /н\s*(?:проф|30)|н30/i.test(item.name ?? "")) score += 10;
  if (layer.key.startsWith("technoruf_") && /технор[уо]ф/i.test(item.name ?? "")) score += 14;
  if (layer.key.includes("_экстра_") && /в\s*экстра/i.test(item.name ?? "")) score += 18;
  if (layer.key.includes("_проф_") && /н\s*проф/i.test(item.name ?? "")) score += 18;
  if (layer.key.includes("_оптима_") && /(?:в|н)\s*оптима/i.test(item.name ?? "")) score += 14;
  if (layer.key.includes("_в60_") && /в\s*60|в60/i.test(item.name ?? "")) score += 14;
  if (layer.key.includes("_н30_") && /н\s*30|н30|h30/i.test(item.name ?? "")) score += 14;
  if (layer.key.startsWith("technoruf_") && layer.thicknessMm) {
    const itemThickness = parseBoardThicknessMm(item.name);
    if (itemThickness === layer.thicknessMm) score += 45;
    else if (itemThickness !== null) score -= 60;
  }
  if (layer.key === "dirock_ruf_n_60" && /dirock|технор[уо]ф\s+н\s+проф/i.test(item.name ?? "")) score += 16;
  if (layer.key === "dirock_ruf_n_60" && /1200[хx*]600[хx*]60\b|[хx*]60(?:\s*мм|\b)|\b60\s*мм/i.test(item.name ?? "")) score += 54;
  if (layer.key === "dirock_ruf_n_60" && !/[хx*]60(?:\s*мм|\b)|\b60\s*мм/i.test(item.name ?? "")) score -= 40;
  if (layer.key === "dirock_ruf_n_60" && /[хx*](?:50|80|100|110|120|130|140|150|160|170)(?:\s*мм|\b)|\b(?:50|80|100|110|120|130|140|150|160|170)\s*мм/i.test(item.name ?? "")) score -= 42;
  if (layer.key === "dirock_ruf_n_60" && /клин/i.test(item.name ?? "")) score -= 80;
  if (layer.key === "dirock_ruf_n_60" && /в\s*60|в60|оптима/i.test(item.name ?? "")) score -= 12;
  if (layer.key === "pirromembrane_70" && /pirromembrane|logicpir\s+prof/i.test(item.name ?? "")) score += 18;
  if (layer.key === "pirromembrane_70" && /70\s*мм|[хx*]70\b|х70\b/i.test(item.name ?? "")) score += 28;
  if (layer.key === "pirromembrane_70" && /баня|interior|slope|30\b|40\b|50\b|80\b|100\b/i.test(item.name ?? "")) score -= 8;
  if (layer.key === "roof_fastener_telescopic_130" && /termoclip|телескоп/i.test(item.name ?? "")) score += 18;
  if (layer.key === "roof_fastener_telescopic_130" && /130\s*мм|140\s*мм|5[,.]5[хx*]35/i.test(item.name ?? "")) score += 12;
  if (layer.key === "pvc_clamping_rail" && /прижимн[а-я\s-]*рейк/i.test(item.name ?? "")) score += 24;
  if (layer.key === "pvc_metal_flashing" && /пвх.?металл|ferroplast/i.test(item.name ?? "")) score += 20;
  if (layer.key === "hydrowind_membrane" && /гидро.?ветрозащит|ветрозащит/i.test(item.name ?? "")) score += 14;
  if (layer.key === "keramzit_slope" && /20-40|20\/40/i.test(item.name ?? "")) score += 4;
  if (layer.key.startsWith("roof_funnel") && /воронк/i.test(item.name ?? "")) score += 18;
  if (layer.key === "roof_funnel_geberit_pluvia" && /geberit|pluvia/i.test(item.name ?? "")) score += 42;
  if (layer.key === "roof_funnel_geberit_pluvia" && /12\s*л\/?\s*сек|12\s*л/i.test(item.name ?? "")) score += 8;
  if (layer.key === "roof_funnel_geberit_pluvia" && /фланц|фартук/i.test(item.name ?? "")) score += 5;
  if (layer.key === "roof_funnel_geberit_pluvia" && /парапет|ремонт/i.test(item.name ?? "")) score -= 14;
  if (layer.key === "roof_funnel_geberit_pluvia" && /технониколь|plastfoil|wigar/i.test(item.name ?? "")) score += 3;
  if (layer.key === "roof_funnel_geberit_pluvia" && /termoclip/i.test(item.name ?? "")) score += 9;
  if (layer.key === "roof_funnel_parapet" && /парапет/i.test(item.name ?? "")) score += 16;
  if (layer.key === "roof_funnel_parapet" && /квадрат/i.test(item.name ?? "")) score += 4;
  if (layer.key === "roof_funnel" && /обжимн|прижимн|вб эко|стандарт/i.test(item.name ?? "")) score += 6;
  if (layer.key === "pergamin" && name.trim() === "пергамин") score += 18;
  if (layer.key === "pergamin" && name.includes("рубероид")) score -= 8;
  if (name.includes(requested)) score += 8;
  if (parseRollArea(item.name) !== null) score += 3;
  if (parsePackageVolume(item.name) !== null) score += 3;
  if (name.includes("пламя стоп")) score -= 5;
  if (/в м3|в м2|сто|пал|уп/i.test(item.name ?? "")) score += 1;
  return score;
}

function hasCriticalThicknessMismatch(layer: DetectedLayer, item: NomenclatureItem | null) {
  if (!item?.name || !layer.thicknessMm) return false;
  const name = item.name.toLowerCase();

  if (
    layer.key === "pvc_logicroof_vrp" ||
    layer.key.startsWith("pvc_plastfoil_classic") ||
    layer.key.startsWith("pvc_plastfoil_art")
  ) {
    const itemThickness = name.match(/(?:^|\s|\()(1[,.][258]|2[,.]0|2)\s*(?:мм|mm|[xх*])?/i)?.[1]?.replace(",", ".");
    return Boolean(itemThickness && itemThickness !== String(layer.thicknessMm));
  }

  if (
    layer.quantityType === "m3" &&
    /технор[уо]ф|xps|carbon|logicpir|pir|dirock|руф|пенополистирол/i.test(`${layer.key} ${layer.label} ${item.name}`)
  ) {
    const itemThickness = parseBoardThicknessMm(item.name);
    return Boolean(itemThickness && itemThickness !== layer.thicknessMm);
  }

  return false;
}

async function findNomenclature(layer: DetectedLayer) {
  if (!layer.searchTerms.length || layer.projectOnly) return [];
  const supabase = getServiceSupabase();
  const found = new Map<string, NomenclatureItem>();
  let hadSupabaseError = false;
  const queryLimit = layer.key === "dirock_ruf_n_60" ? 30 : 10;

  for (const term of layer.searchTerms) {
    const { data, error } = await supabase
      .from("nomenclature_1c")
      .select("code,name,brand")
      .ilike("name", buildSearchPattern(term))
      .limit(queryLimit);

    if (error) {
      hadSupabaseError = true;
      console.warn(`Supabase nomenclature search failed for "${term}":`, errorMessage(error));
      continue;
    }
    for (const item of (data ?? []) as NomenclatureItem[]) {
      const key = `${item.code ?? ""}:${item.name ?? ""}`;
      found.set(key, item);
    }
  }

  const resultLimit = layer.key === "roof_funnel_geberit_pluvia" ? 16 : 3;
  const supabaseResult = Array.from(found.values())
    .sort((a, b) => itemScore(b, layer) - itemScore(a, layer))
    .slice(0, resultLimit);

  if (supabaseResult.length) return supabaseResult;

  if (hadSupabaseError) {
    try {
      return await findLocalNomenclature(layer);
    } catch (error) {
      console.warn("Local nomenclature fallback is unavailable:", errorMessage(error));
    }
  }

  return [];
}

async function loadLocalNomenclature() {
  if (localNomenclatureCache) return localNomenclatureCache;
  const filePath = path.join(process.cwd(), "scripts", "nomenclature_data.json");
  const raw = await fs.readFile(filePath, "utf8");
  localNomenclatureCache = JSON.parse(raw) as NomenclatureItem[];
  return localNomenclatureCache;
}

async function findLocalNomenclature(layer: DetectedLayer) {
  const rows = await loadLocalNomenclature();
  const terms = layer.searchTerms.map((term) => term.toLowerCase().split(/\s+/).filter(Boolean));
  return rows
    .filter((item) => {
      const name = (item.name ?? "").toLowerCase();
      return terms.some((parts) => parts.every((part) => name.includes(part)));
    })
    .sort((a, b) => itemScore(b, layer) - itemScore(a, layer))
    .slice(0, layer.key === "roof_funnel_geberit_pluvia" ? 16 : 3);
}

function parseRollArea(name: string | null) {
  if (!name) return null;
  const m2Match = name.match(/(\d+(?:[,.]\d+)?)\s*(?:м2|м²)/i);
  if (m2Match?.[1]) return toNumber(m2Match[1]);

  const sizeMatch = name.match(/(\d+(?:[,.]\d+)?)\s*[xхХ*]\s*(\d+(?:[,.]\d+)?)\s*м/i);
  if (sizeMatch?.[1] && sizeMatch?.[2]) {
    const first = toNumber(sizeMatch[1]);
    const second = toNumber(sizeMatch[2]);
    if (first > 0 && second > 0 && first <= 5 && second <= 100) return first * second;
  }
  return null;
}

function parsePackageArea(name: string | null) {
  if (!name || !/уп|упак|плит/i.test(name)) return null;
  const matches = Array.from(name.matchAll(/(\d+(?:[,.]\d+)?)\s*(?:м2|м²)(?!\s*\/\s*под)/gi));
  if (!matches.length) return null;
  const last = matches[matches.length - 1]?.[1];
  if (!last) return null;
  const value = toNumber(last);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parsePackageVolume(name: string | null) {
  if (!name) return null;
  const packageMatch = name.match(/(\d+(?:[,.]\d+)?)\s*(?:м3|м³)\s*\/\s*(?:уп|упак|упаков)/i);
  if (packageMatch?.[1]) {
    const value = toNumber(packageMatch[1]);
    if (Number.isFinite(value) && value > 0) return value;
  }

  const matches = Array.from(name.matchAll(/(\d+(?:[,.]\d+)?)\s*(?:м3|м³)(?!\s*\/\s*под)/gi));
  if (!matches.length) return null;
  const last = matches[matches.length - 1]?.[1];
  if (!last) return null;
  const value = toNumber(last);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function parseBoardThicknessMm(name: string | null) {
  if (!name) return null;
  const dimensionMatches = Array.from(name.matchAll(/[xхХ*]\s*(\d{2,3})\s*(?:мм|mm)?(?=\D|$)/gi));
  const lastDimension = dimensionMatches.length ? dimensionMatches[dimensionMatches.length - 1]?.[1] : undefined;
  if (lastDimension) {
    const value = Number(lastDimension);
    if (Number.isFinite(value) && value >= 10 && value <= 300) return value;
  }

  const mmMatch = name.match(/(?:^|\s)(\d{2,3})\s*(?:мм|mm)(?=\D|$)/i);
  if (mmMatch?.[1]) {
    const value = Number(mmMatch[1]);
    if (Number.isFinite(value) && value >= 10 && value <= 300) return value;
  }
  return null;
}

function buildQuantity(layer: DetectedLayer, area: AreaInfo, item: NomenclatureItem | null) {
  if (layer.quantityOverride) {
    const qty = layer.quantityOverride.value;
    if (layer.quantityOverride.unit === "шт") {
      return {
        value: qty,
        text: `${round(qty, 2)} шт по ведомости проекта`,
      };
    }

    if (layer.quantityOverride.unit === "m2") {
      const packageArea = parsePackageArea(item?.name ?? null);
      const rollArea = packageArea === null ? parseRollArea(item?.name ?? null) : null;
      return {
        value: round(qty, 2),
        text: packageArea !== null
          ? `${round(qty, 2)} м2 по ведомости проекта, ориентир ${Math.ceil(qty / packageArea)} уп. по ${round(packageArea, 4)} м2`
          : rollArea !== null
            ? `${round(qty, 2)} м2 по ведомости проекта, ориентир ${Math.ceil(qty / rollArea)} рул. по ${round(rollArea, 2)} м2`
            : `${round(qty, 2)} м2 по ведомости проекта`,
      };
    }

    const packageVolume = parsePackageVolume(item?.name ?? null);
    return {
      value: round(qty, 3),
      text: packageVolume !== null
        ? `${round(qty, 3)} м3 по ведомости проекта, ориентир ${Math.ceil(qty / packageVolume)} уп. по ${round(packageVolume, 4)} м3`
        : `${round(qty, 3)} м3 по ведомости проекта`,
    };
  }

  if (layer.quantityType === "project") {
    return {
      value: layer.unitCount ?? null,
      text: layer.unitCount ? `${layer.unitCount} шт по проекту/задаче менеджера; тип воронки сверить по проекту водоотвода.` : layer.note ?? "Расход по проекту.",
    };
  }

  const basisArea = layer.areaOverride ?? area.value;
  if (!basisArea) {
    return {
      value: null,
      text: "Площадь кровли не найдена; количество не рассчитано.",
    };
  }

  if (layer.quantityType === "m2") {
    const qty = basisArea * (layer.factor ?? 1);
    const packageArea = parsePackageArea(item?.name ?? null);
    const rollArea = packageArea === null ? parseRollArea(item?.name ?? null) : null;
    return {
      value: round(qty, 2),
      text: packageArea !== null
        ? `${round(qty, 2)} м2, ориентир ${Math.ceil(qty / packageArea)} уп. по ${round(packageArea, 4)} м2`
        : rollArea !== null
          ? `${round(qty, 2)} м2, ориентир ${Math.ceil(qty / rollArea)} рул. по ${round(rollArea, 2)} м2`
          : `${round(qty, 2)} м2`,
    };
  }

  if (layer.quantityType === "m3" && layer.thicknessMm) {
    const qty = basisArea * (layer.thicknessMm / 1000) * (layer.factor ?? 1);
    const packageVolume = parsePackageVolume(item?.name ?? null);
    if (packageVolume !== null) {
      return {
        value: round(qty, 3),
        text: `${round(qty, 3)} м3, ориентир ${Math.ceil(qty / packageVolume)} уп. по ${round(packageVolume, 4)} м3`,
      };
    }
    if (layer.key === "cement_screed") {
      return {
        value: round(qty, 3),
        text: `${round(qty, 3)} м3 стяжки; количество мешков считать по норме расхода ЦПС/проекту`,
      };
    }
    return {
      value: round(qty, 3),
      text: `${round(qty, 3)} м3 (${round(basisArea * (layer.factor ?? 1), 2)} м2 x ${layer.thicknessMm} мм)`,
    };
  }

  return {
    value: null,
    text: layer.note ?? "Расход по проекту.",
  };
}

function isRoofWoolProjectLayer(layer: DetectedLayer) {
  const text = `${layer.key} ${layer.role} ${layer.label}`.toLowerCase();
  return /technoruf|технор[уо]ф|dirock|дирок|isover|изовер|минераловатн|roof_mw/i.test(text)
    && /кровл|руф|roof|теплоизоляц/i.test(text);
}

function isUpperRoofWoolLayer(layer: DetectedLayer) {
  const text = `${layer.key} ${layer.role} ${layer.label}`.toLowerCase();
  return /верхн|руф\s*в|ruf\s*v|_в|в\s*(?:60|проф|экстра|оптима)|в60/i.test(text);
}

function roofWoolAnalogTerms(layer: DetectedLayer) {
  if (isUpperRoofWoolLayer(layer)) {
    return ["BASWOOL РУФ В", "BASWOOL РУФ В 170", "BASWOOL РУФ В 180", "BASWOOL РУФ В 160"];
  }

  return ["BASWOOL РУФ Н", "BASWOOL РУФ Н 110", "BASWOOL РУФ Н 100", "BASWOOL РУФ Н 120"];
}

function baswoolRoofAnalogScore(item: NomenclatureItem, layer: DetectedLayer) {
  const name = (item.name ?? "").toLowerCase();
  let score = item.code ? 10 : 0;
  if (/baswool|басвул|басвол/i.test(item.name ?? "")) score += 50;
  if (/руф|ruf/i.test(name)) score += 20;
  if (/фасад|вент|лайт|стандарт|сэндвич/i.test(name)) score -= 30;

  if (isUpperRoofWoolLayer(layer)) {
    if (/руф\s*в|ruf\s*v/i.test(name)) score += 35;
    if (/руф\s*н|ruf\s*n/i.test(name)) score -= 35;
    if (/руф\s*в\s*(?:160|170|180|190)|в\s*(?:160|170|180|190)/i.test(name)) score += 12;
  } else {
    if (/руф\s*н|ruf\s*n/i.test(name)) score += 35;
    if (/руф\s*в|ruf\s*v/i.test(name)) score -= 35;
    if (/руф\s*н\s*(?:100|110|120)|н\s*(?:100|110|120)/i.test(name)) score += 12;
  }

  if (layer.thicknessMm) {
    const thickness = String(layer.thicknessMm);
    if (new RegExp(`[хx*]${thickness}(?:\\s*мм|\\b)|\\b${thickness}\\s*мм`).test(name)) score += 18;
    if (layer.thicknessMm === 100 && /[хx*]50(?:\s*мм|\b)|\b50\s*мм/i.test(name)) score += 4;
  }

  if (parsePackageVolume(item.name) !== null) score += 6;
  return score;
}

async function findRoofWoolAnalogCandidates(layer: DetectedLayer) {
  const supabase = getServiceSupabase();
  const found = new Map<string, NomenclatureItem>();

  for (const term of roofWoolAnalogTerms(layer)) {
    const { data, error } = await supabase
      .from("nomenclature_1c")
      .select("code,name,brand")
      .ilike("name", buildSearchPattern(term))
      .limit(30);

    if (error) {
      console.warn(`Roof wool analog search failed for "${term}":`, errorMessage(error));
      continue;
    }

    for (const item of (data ?? []) as NomenclatureItem[]) {
      const key = `${item.code ?? ""}:${item.name ?? ""}`;
      found.set(key, item);
    }
  }

  return Array.from(found.values())
    .sort((a, b) => baswoolRoofAnalogScore(b, layer) - baswoolRoofAnalogScore(a, layer))
    .slice(0, 2);
}

async function buildRoofAnalogRecommendations(layers: DetectedLayer[], area: AreaInfo) {
  const recommendations: AnalogRecommendation[] = [];
  const used = new Set<string>();

  for (const layer of layers) {
    if (!isRoofWoolProjectLayer(layer) || layer.projectOnly) continue;
    const candidates = await findRoofWoolAnalogCandidates(layer);
    const candidate = candidates[0] ?? null;
    if (!candidate?.code) continue;

    const key = `${layer.key}:${candidate.code}`;
    if (used.has(key)) continue;
    used.add(key);

    const quantity = buildQuantity(layer, area, candidate);
    const parsedQuantity = extractQuoteQuantity(quantity.text);
    recommendations.push({
      role: layer.role,
      projectMaterial: layer.label,
      analogMaterial: candidate.name,
      code: candidate.code,
      brand: candidate.brand,
      quantity: parsedQuantity.quantity,
      unit: parsedQuantity.unit,
      calculation: quantity.text,
      note: "Коммерческий аналог BASWOOL РУФ на согласование: сохранить роль слоя и толщину/общую толщину из проекта; перед заменой сверить прочность, плотность и пожарный сертификат.",
    });
  }

  return recommendations;
}

function normalizeSystemText(value: string) {
  return value
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[®™]/g, "")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractSystemNameFromRule(rule: SystemRuleContext) {
  const match = String(rule.rule_name || "").match(/^Система\s+(.+?)(?:\s+—|$)/i);
  return match?.[1]?.trim() || "";
}

function detectProjectSystemContext(text: string, layers: DetectedLayer[]): ProjectSystemContext | null {
  const lower = text.toLowerCase();
  const hasLayer = (key: string) => layers.some((layer) => layer.key === key);
  const hasPvcMembrane =
    /пвх|pvc|plastfoil|пластфойл|logicroof|ecoplast/i.test(lower) ||
    layers.some((layer) => /пвх-мембран|pvc|plastfoil|logicroof/i.test(`${layer.key} ${layer.role} ${layer.label}`));
  const hasProfiledSheet =
    /профилированн[а-я\s-]*лист|профлист|н\s*114|н114|настил/i.test(lower) ||
    hasLayer("profiled_sheet_n114") ||
    hasLayer("profiled_sheet_n57");
  const hasMechanicalFastening =
    /механическ[а-я\s-]*креп|телескопическ[а-я\s-]*креп|саморез|шайб/i.test(lower) ||
    hasLayer("roof_fastener_telescopic_130");
  const hasPirLayer =
    /pirromembrane|pirro|пирро|logicpir|пир[-\s]*плит/i.test(lower) ||
    hasLayer("pirromembrane_70") ||
    layers.some((layer) => layer.key.startsWith("logicpir_"));
  const hasStoneWoolLayer =
    /dirock|дирок|isover|изовер|техноруф|минераловатн/i.test(lower) ||
    hasLayer("dirock_ruf_n_60") ||
    layers.some((layer) => layer.key.startsWith("technoruf_"));
  const hasPenoplexKombi =
    /комби\s*(?:pir|пир)|пеноплекс[\s\S]{0,120}комби/i.test(lower) ||
    (/plastfoil\s+classic|пластфойл[\s\S]{0,40}classic/i.test(lower) && /pirromembrane|pirro|пирро|dirock|дирок/i.test(lower));

  const directSystems: Array<{ id: string; name: string; pattern: RegExp }> = [
    {
      id: "tn_roof_smart_pir",
      name: "ТН-КРОВЛЯ Смарт PIR",
      pattern: /тн[-\s]*кровл[яьи]\s*смарт\s*(?:pir|пир)|смарт\s*(?:pir|пир)|logicpir\s+prof[\s\S]{0,160}(?:профлист|пвх|logicroof)/i,
    },
    {
      id: "tn_roof_klassik",
      name: "ТН-КРОВЛЯ Классик",
      pattern: /тн[-\s]*кровл[яьи]\s*классик(?!\s*проф)|кровл[яьи][\s\S]{0,80}классик(?!\s*проф)/i,
    },
    {
      id: "tn_roof_smart",
      name: "ТН-КРОВЛЯ Смарт",
      pattern: /тн[-\s]*кровл[яьи]\s*смарт(?!\s*(?:pir|пир))|кровл[яьи][\s\S]{0,80}смарт(?!\s*(?:pir|пир))/i,
    },
    {
      id: "tn_roof_praktik_kley",
      name: "ТН-КРОВЛЯ Практик Клей",
      pattern: /тн[-\s]*кровл[яьи]\s*практик\s*клей|практик\s*клей|logicroof\s+bond|v[-\s]*gr\s*fb/i,
    },
  ];

  for (const system of directSystems) {
    if (system.pattern.test(lower)) {
      return {
        ...system,
        source: "nav_tn",
        confidence: "high",
        reason: "Название системы или характерный системный материал найден в PDF.",
        navAnalogId: system.id,
        navAnalogName: system.name,
        rules: [],
      };
    }
  }

  if (hasPenoplexKombi || (/plastfoil/i.test(lower) && hasPirLayer && hasStoneWoolLayer)) {
    return {
      id: "penoplex_kombi_pir_plastfoil",
      name: "Пеноплекс Комби PIR / Plastfoil Classic",
      source: "pdf",
      confidence: hasPvcMembrane && hasPirLayer && hasStoneWoolLayer ? "high" : "medium",
      reason: "В PDF найдены Plastfoil Classic/Art, PIR-слой PirroMembrane, минватный слой Dirock РУФ Н и механическое крепление к профлисту.",
      navAnalogId: "tn_roof_smart_pir",
      navAnalogName: "ТН-КРОВЛЯ Смарт PIR",
      warning: "Это не система ТЕХНОНИКОЛЬ: NAV.TN-карточку использовать только как ближайшую схему ролей и расходных коэффициентов. Материалы Пеноплекс/Plastfoil не заменять автоматически без согласования.",
      rules: [],
    };
  }

  if (hasPvcMembrane && hasProfiledSheet && hasMechanicalFastening) {
    const analog = hasPirLayer ? {
      id: "tn_roof_smart_pir",
      name: "ТН-КРОВЛЯ Смарт PIR",
    } : {
      id: "tn_roof_klassik",
      name: "ТН-КРОВЛЯ Классик",
    };

    return {
      id: analog.id,
      name: analog.name,
      source: "inferred",
      confidence: hasStoneWoolLayer || hasPirLayer ? "medium" : "low",
      reason: "Система определена по признакам: ПВХ-мембрана, профлист/настил и механическое крепление.",
      navAnalogId: analog.id,
      navAnalogName: analog.name,
      warning: "Система определена по признакам, а не по прямому названию в проекте; перед КП сверить с листом состава кровли.",
      rules: [],
    };
  }

  return null;
}

async function loadProjectSystemRules(system: ProjectSystemContext | null) {
  if (!system) return [];

  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from("selection_rules")
      .select("id, rule_name, condition, rule_text, priority, is_prohibition, category")
      .order("priority", { ascending: true });

    if (error) {
      console.warn("project system rules search skipped:", errorMessage(error));
      return [];
    }

    const names = [system.name, system.navAnalogName].filter(Boolean).map((name) => normalizeSystemText(String(name)));
    const ids = [system.id, system.navAnalogId].filter(Boolean).map((id) => normalizeSystemText(String(id)));
    const rules = (data ?? []) as SystemRuleContext[];

    return rules
      .filter((rule) => {
        const ruleSystemName = normalizeSystemText(extractSystemNameFromRule(rule));
        if (ruleSystemName) return names.includes(ruleSystemName);

        const haystack = normalizeSystemText(`${rule.category || ""} ${rule.condition || ""} ${rule.rule_name || ""} ${rule.rule_text || ""}`);
        if (ids.some((id) => id && haystack.includes(id))) return true;
        return names.some((name) => name && haystack.includes(name));
      })
      .slice(0, 8);
  } catch (error) {
    console.warn("project system rules search failed:", errorMessage(error));
    return [];
  }
}

function buildProjectSystemRoleLines(system: ProjectSystemContext | null) {
  if (!system) return [];

  const name = normalizeSystemText(`${system.name} ${system.navAnalogName ?? ""}`);

  if (name.includes("тн кровля классик")) {
    return [
      "Скелет системы ТН-КРОВЛЯ Классик для расчета:",
      "- кровельный ковер: LOGICROOF V-RP / PRO V-RP, считать площадь × 1,15; без толщины мембрану не ставить в счет;",
      "- крепеж мембраны: TERMOCLIP саморез + телескоп, финально только по ветровому расчету;",
      "- верхний слой утепления: ТЕХНОРУФ В ЭКСТРА / В ПРОФ / В60 по проекту, считать площадь × 1,03 × толщину;",
      "- нижний слой утепления: ТЕХНОРУФ Н ПРОФ / Н30 / Н ОПТИМА по проекту, считать площадь × 1,03 × толщину;",
      "- уклонообразующий слой: ТЕХНОРУФ КЛИН / LOGICPIR SLOPE / XPS SLOPE, считать только по схеме уклонов;",
      "- пароизоляция: Паробарьер СА500 / СФ1000 / указанная в проекте, считать площадь × 1,12;",
      "- основание профлист: по КМ/КМД, автоматически в счет кровельных материалов не ставить;",
      "- водоотвод: воронки/желоба только по проекту водоотвода или калькулятору.",
    ];
  }

  if (name.includes("тн кровля смарт pir") || name.includes("тн кровля смарт пир")) {
    return [
      "Скелет системы ТН-КРОВЛЯ Смарт PIR для расчета:",
      "- сначала определить площадь и периметр кровли по ведомости/плану; периметр нужен для парапетов и примыканий;",
      "- кровельный ковер: LOGICROOF V-RP / PRO V-RP, считать площадь × 1,15; толщину и группу горючести сверять по проекту;",
      "- нижний слой утепления: ТЕХНОРУФ Н ПРОФ / Н ОПТИМА / Н30 по проекту, считать площадь × 1,03 × толщину;",
      "- верхний слой PIR: LOGICPIR PROF по проекту, считать площадь × 1,03 × толщину;",
      "- уклоны и контруклоны: LOGICPIR SLOPE / CARBON PROF SLOPE / ТЕХНОРУФ КЛИН считать только по плану уклонов или отдельному калькулятору;",
      "- пароизоляция: брать марку из проекта; считать площадь × 1,12;",
      "- крепеж: финально по ветровому расчету, предварительный ориентир можно давать отдельно;",
      "- ПВХ-комплектация узлов: неармированная мембрана, очиститель ПВХ, жидкий ПВХ, рейки/планки — по узлам, периметру и ведомости;",
      "- водоотвод: количество ВВ/ВП снимать с плана кровли или брать из ведомости; если воронок нет, запросить схему водоотвода.",
    ];
  }

  return [];
}

function buildProjectQuery(summary: {
  direction: string;
  question: string;
  area: AreaInfo;
  layers: DetectedLayer[];
  systemContext?: ProjectSystemContext | null;
}) {
  const layerText = summary.layers.map((layer) => layer.label).join("; ");
  return [
    `Проект ${summary.direction || "кровля"}`,
    summary.question,
    summary.systemContext ? `система ${summary.systemContext.name}` : "",
    summary.area.value ? `площадь ${summary.area.value} м2` : "",
    layerText,
    "подбери материалы с кодами 1С, коды не придумывать",
  ]
    .filter(Boolean)
    .join(". ");
}

function compactProjectSystem(systemContext: ProjectSystemContext | null) {
  if (!systemContext) return null;
  return {
    id: systemContext.id,
    name: systemContext.name,
    source: systemContext.source,
    confidence: systemContext.confidence,
    reason: systemContext.reason,
    navAnalogId: systemContext.navAnalogId ?? null,
    navAnalogName: systemContext.navAnalogName ?? null,
    warning: systemContext.warning ?? null,
    rulesCount: systemContext.rules.length,
    ruleNames: systemContext.rules
      .map((rule) => rule.rule_name)
      .filter(Boolean)
      .slice(0, 8),
  };
}

function extractQuoteQuantity(calculation: string) {
  const orientMatch = calculation.match(/ориентир\s+(\d+(?:[,.]\d+)?)\s*(рул|уп|меш|шт)\.?/i);
  if (orientMatch?.[1] && orientMatch?.[2]) {
    return {
      quantity: orientMatch[1].replace(",", "."),
      unit: orientMatch[2].replace(/\.$/, ""),
    };
  }

  const unitMatch = calculation.match(/^(\d+(?:[,.]\d+)?)\s*(шт|м2|м²|м3|м³)(?=\s|$|[;,.])/i);
  if (unitMatch?.[1] && unitMatch?.[2]) {
    return {
      quantity: unitMatch[1].replace(",", "."),
      unit: unitMatch[2].replace("²", "2").replace("³", "3"),
    };
  }

  return {
    quantity: "по проекту",
    unit: "расчет",
  };
}

function buildQuoteItems(invoiceItems: InvoiceItem[]): QuoteItem[] {
  return invoiceItems.map((item, index) => {
    const qty = extractQuoteQuantity(item.calculation);
    return {
      no: index + 1,
      code: item.code,
      material: item.material,
      unit: qty.unit,
      quantity: qty.quantity,
      calculation: item.calculation,
      role: item.role,
      note: item.note,
    };
  });
}

function buildPendingQuantityLines(notFound: ReviewItem[]) {
  const lines: string[] = [];

  for (const item of notFound) {
    const text = `${item.role} ${item.requestedLayer} ${item.material ?? ""}`.toLowerCase();
    const calculation = item.calculation.replace(/\.$/, "");
    if (!/\d/.test(calculation) || !/(?:м2|м²|м3|м³|шт|рул|уп)/i.test(calculation)) continue;

    if (/logicroof|лоджикруф|пвх-мембран|пвх мембран/.test(text)) {
      lines.push(`- ${item.requestedLayer}: ${calculation}. Уточнить толщину мембраны 1,2 / 1,5 / 1,8 / 2,0 мм; после выбора толщины подобрать точный код 1С и рулоны.`);
      continue;
    }

    if (/гидроветрозащит|гидро.?ветрозащит|ветрозащит/.test(text)) {
      lines.push(`- ${item.requestedLayer}: ${calculation}. Уточнить марку/тип мембраны и допустимость в этой кровельной системе; после этого подобрать код 1С.`);
    }
  }

  return lines;
}

function buildQuoteDraft(summary: {
  fileName: string;
  area: AreaInfo;
  systemContext?: ProjectSystemContext | null;
  quoteItems: QuoteItem[];
  invoiceItems: InvoiceItem[];
  analogRecommendations: AnalogRecommendation[];
  roofFastenerGuidance?: ReturnType<typeof buildRoofFastenerGuidance>;
  notFound: ReviewItem[];
  projectOnly: Array<{ role: string; material: string; note?: string }>;
}) {
  const lines: string[] = [];
  lines.push(`Черновик КП без цен: ${summary.fileName}`);
  lines.push(`Площадь: ${summary.area.value ? `${summary.area.value} м2 (${summary.area.source})` : "не найдена"}`);
  if (summary.area.note) {
    lines.push(`Основание площади: ${summary.area.note}`);
  }
  lines.push("");

  if (summary.systemContext) {
    lines.push(`Система проекта: ${summary.systemContext.name} (${summary.systemContext.confidence})`);
    if (summary.systemContext.navAnalogName && summary.systemContext.navAnalogName !== summary.systemContext.name) {
      lines.push(`Ближайшая NAV.TN-схема для сверки ролей: ${summary.systemContext.navAnalogName}`);
    }
    lines.push(`Почему: ${summary.systemContext.reason}`);
    if (summary.systemContext.warning) {
      lines.push(`Важно: ${summary.systemContext.warning}`);
    }
    if (summary.systemContext.rules.length) {
      const ruleNames = summary.systemContext.rules
        .map((rule) => rule.rule_name)
        .filter(Boolean)
        .slice(0, 4)
        .join("; ");
      lines.push(`Подтянуты системные правила: ${ruleNames}`);
    }
    const systemRoleLines = buildProjectSystemRoleLines(summary.systemContext);
    if (systemRoleLines.length) {
      lines.push(...systemRoleLines);
    }
    lines.push("");
  }

  if (summary.quoteItems.length) {
    lines.push("В счет:");
    lines.push("№ | Код 1С | Наименование | Кол-во | Ед. | Основание расчета");
    for (const item of summary.quoteItems) {
      lines.push(`${item.no} | ${item.code ?? "код не найден"} | ${item.material ?? "материал не найден"} | ${item.quantity} | ${item.unit} | ${item.calculation}`);
    }
  } else {
    const pendingWithCodes = summary.notFound.filter((item) => item.code);
    if (pendingWithCodes.length) {
      lines.push("В счет: счетные позиции не поставлены, потому что не хватает площади/количества. Материалы с кодами ниже в блоке проверки.");
    } else {
      lines.push("В счет: счетные позиции с кодами 1С автоматически не найдены.");
    }
  }

  if (summary.analogRecommendations.length) {
    lines.push("");
    lines.push("Аналоги из нашего ассортимента на согласование:");
    lines.push("№ | Проектный слой | Аналог | Код 1С | Кол-во | Ед. | Расчет");
    summary.analogRecommendations.forEach((item, index) => {
      lines.push(`${index + 1} | ${item.projectMaterial} | ${item.analogMaterial ?? "материал не найден"} | ${item.code ?? "код не найден"} | ${item.quantity} | ${item.unit} | ${item.calculation}`);
    });
    lines.push("Сначала считать проектное решение, затем согласовывать замену на аналог по прочности, плотности, толщине и пожарному сертификату.");
  }

  if (summary.roofFastenerGuidance?.shouldMention && summary.area.value) {
    const rates = summary.roofFastenerGuidance.preliminaryRates;
    const insulationFasteners = Math.ceil(summary.area.value * rates.insulationFastenersPerM2);
    const membraneFasteners = Math.ceil(summary.area.value * rates.membraneFieldKitsPerM2);
    const totalFasteners = Math.ceil(summary.area.value * rates.totalFieldFastenersPerM2);
    lines.push("");
    lines.push("Крепеж, предварительный ориентир:");
    lines.push(`- теплоизоляция: ${rates.insulationFastenersPerM2} шт/м2 × ${summary.area.value} м2 = ${insulationFasteners} шт;`);
    lines.push(`- мембрана по полю: ${rates.membraneFieldKitsPerM2} комплект/м2 × ${summary.area.value} м2 = ${membraneFasteners} комплектов;`);
    lines.push(`- общий ориентир поля: ${rates.totalFieldFastenersPerM2} крепежных комплектов/м2 × ${summary.area.value} м2 = ${totalFasteners} шт/комплектов.`);
    lines.push("Финально крепеж считать по ветровому расчету: краевые, угловые и периметральные зоны могут потребовать больше.");
  }

  const pendingQuantityLines = buildPendingQuantityLines(summary.notFound);
  if (pendingQuantityLines.length) {
    lines.push("");
    lines.push("К расчету после уточнения:");
    lines.push(...pendingQuantityLines);
  }

  const funnelAlternativeSources = [
    ...summary.invoiceItems.map((item) => ({
      role: item.role,
      requestedLayer: item.requestedLayer,
      material: item.material,
      alternatives: item.alternatives,
    })),
    ...summary.notFound.map((item) => ({
      role: item.role,
      requestedLayer: item.requestedLayer,
      material: item.material,
      alternatives: item.alternatives ?? [],
    })),
  ].filter((item) => /воронк|водоотвод|водосточ/i.test(`${item.role} ${item.requestedLayer} ${item.material ?? ""}`));

  const funnelAlternativeLines: string[] = [];
  const usedFunnelAlternatives = new Set<string>();
  for (const source of funnelAlternativeSources) {
    for (const alternative of source.alternatives ?? []) {
      const name = alternative.name ?? "";
      if (!alternative.code || !name || !/воронк|geberit|pluvia|plastfoil|wigar|termoclip|технониколь/i.test(name)) continue;
      const key = `${alternative.code}:${name}`;
      if (usedFunnelAlternatives.has(key)) continue;
      usedFunnelAlternatives.add(key);
      funnelAlternativeLines.push(`- ${alternative.code} — ${name}`);
    }
  }

  if (funnelAlternativeLines.length) {
    lines.push("");
    lines.push("Воронки/аналоги на согласование:");
    lines.push(...funnelAlternativeLines.slice(0, 14));
    lines.push("Основную воронку из проекта не заменять автоматически; подобрать аналог только после согласования типа, диаметра/размера, обогрева и схемы водоотвода.");
  }

  if (summary.notFound.length) {
    lines.push("");
    lines.push("Проверить перед КП:");
    for (const item of summary.notFound) {
      const calculation = item.calculation.replace(/\.$/, "");
      const normalizedNote = item.note?.replace(/\.$/, "");
      const note = normalizedNote && !calculation.includes(normalizedNote) ? ` ${normalizedNote}.` : "";
      const matchedMaterial =
        item.material && item.material !== item.requestedLayer ? ` -> ${item.material}` : "";
      const code = item.code ? ` Код 1С: ${item.code}.` : "";
      lines.push(`- ${item.role}: ${item.requestedLayer}${matchedMaterial}.${code} ${calculation}.${note}`);
    }
  }

  if (summary.projectOnly.length) {
    lines.push("");
    lines.push("Проектные слои, не ставить в счет материалов:");
    for (const item of summary.projectOnly) {
      lines.push(`- ${item.role}: ${item.material}`);
    }
  }

  return lines.join("\n");
}

async function saveProjectEstimateLog(payload: Record<string, unknown>) {
  try {
    const supabase = getServiceSupabase();
    const { data, error } = await supabase
      .from("project_estimate_logs")
      .insert(payload)
      .select("id")
      .single();

    if (error) {
      console.warn("project_estimate_logs insert skipped:", errorMessage(error));
      return null;
    }

    return typeof data?.id === "string" ? data.id : null;
  } catch (error) {
    console.warn("project_estimate_logs insert failed:", errorMessage(error));
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    const direction = String(form.get("direction") || "кровля");
    const question = String(form.get("question") || "");
    const manualArea = form.get("area") ? String(form.get("area")) : null;
    const responseMode = String(
      form.get("responseMode") ||
      form.get("compact") ||
      request.nextUrl.searchParams.get("responseMode") ||
      request.nextUrl.searchParams.get("compact") ||
      "compact"
    ).toLowerCase();
    const isFullResponse = responseMode === "full" || responseMode === "0" || responseMode === "false";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "PDF file is required" }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
      return NextResponse.json({ error: "Only PDF files are supported" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const pdf = (await import("pdf-parse")).default;
    const parsed = await pdf(buffer);
    const extractedText = normalizeText(parsed.text || "");

    if (extractedText.length < 100) {
      return NextResponse.json(
        {
          error: "Не удалось извлечь текст из PDF. Вероятно, это скан: нужен OCR-режим.",
          fileName: file.name,
          chars: extractedText.length,
        },
        { status: 422 }
      );
    }

    let area = detectRoofArea(extractedText, manualArea);
    let layers = detectLayers(extractedText, question);
    const shouldRunAi = shouldRunAiExtraction({ direction, question, area, layers });
    const aiExtraction = await extractRoofProjectWithAi({
      text: extractedText,
      question,
      direction,
      shouldRun: shouldRunAi,
    });
    const groundedAiExtraction = aiExtraction.status === "ok"
      ? groundAiExtraction(aiExtraction, extractedText)
      : aiExtraction;

    if (groundedAiExtraction.status === "ok") {
      const aiLayers = buildAiDetectedLayers(groundedAiExtraction);
      layers = mergeDetectedLayers(layers, aiLayers);

      if (
        groundedAiExtraction.roofAreaM2 &&
        groundedAiExtraction.roofAreaM2 > 0 &&
        groundedAiExtraction.roofAreaConfidence !== "none" &&
        (area.source === "not_found" || area.source === "axes_estimate" || area.confidence === "low")
      ) {
        const aiAreaSource = groundedAiExtraction.roofAreaSource ?? "";
        const isBuildingFootprintArea = /площад[ьи]\s+застройки/i.test(aiAreaSource);
        area = {
          value: round(groundedAiExtraction.roofAreaM2, 2),
          source: "pdf_text",
          confidence: isBuildingFootprintArea ? "low" : groundedAiExtraction.roofAreaConfidence === "high" ? "high" : "medium",
          note: isBuildingFootprintArea
            ? `AI нашел площадь застройки как запасной ориентир: ${aiAreaSource}. Для счета нужна площадь кровли/покрытия по проекту или плану кровли.`
            : `Площадь кровли извлечена AI-экстрактором из PDF. ${aiAreaSource || "Перед счетом сверить с ведомостью/планом кровли."}`,
        };
      }
    }

    const mainMembraneArea = mainRoofMembraneAreaFromLayers(layers);
    if (
      mainMembraneArea &&
      mainMembraneArea > 0 &&
      (area.source === "not_found" || area.source === "axes_estimate" || area.confidence === "low")
    ) {
      area = {
        value: round(mainMembraneArea, 2),
        source: "pdf_text",
        confidence: "medium",
        note: "Площадь кровли взята из площади основной ПВХ-мембраны в спецификации проекта как запасной источник. Для финального КП сверить с ведомостью/планом кровли.",
      };
    }

    const roofFastenerGuidance = buildRoofFastenerGuidance(extractedText, question);
    const roofDrainGuidance = buildRoofDrainGuidance(extractedText, question, layers);
    const detectedProjectSystem = detectProjectSystemContext(extractedText, layers);
    const projectSystem = detectedProjectSystem
      ? {
        ...detectedProjectSystem,
        rules: await loadProjectSystemRules(detectedProjectSystem),
      }
      : null;
    const projectQuery = buildProjectQuery({ direction, question, area, layers, systemContext: projectSystem });

    const invoiceItems: InvoiceItem[] = [];
    const notFound: ReviewItem[] = [];
    const projectOnly: Array<{ role: string; material: string; note?: string }> = [];

    for (const layer of layers) {
      if (layer.projectOnly) {
        projectOnly.push({
          role: layer.role,
          material: layer.label,
          note: layer.note,
        });
        continue;
      }

      const matches = await findNomenclature(layer);
      const primary = matches[0] ?? null;
      const quantity = buildQuantity(layer, area, primary);
      const requiresProjectQuantity = layer.key.startsWith("roof_funnel") && !layer.unitCount;
      const requiresMeasuredQuantity = layer.quantityType !== "project" && quantity.value === null;
      const hasThicknessMismatch = hasCriticalThicknessMismatch(layer, primary);

      if (primary?.code && !layer.reviewOnly && !requiresProjectQuantity && !requiresMeasuredQuantity && !hasThicknessMismatch) {
        invoiceItems.push({
          role: layer.role,
          material: primary.name,
          requestedLayer: layer.label,
          code: primary.code,
          brand: primary.brand,
          calculation: quantity.text,
          note: layer.note ?? null,
          alternatives: matches.slice(1).map((item) => ({
            code: item.code,
            name: item.name,
            brand: item.brand,
          })),
        });
      } else {
        const missingReason = layer.reviewOnly
          ? layer.note ?? "Позиция найдена как возможный вариант, но требует согласования перед включением в КП."
          : hasThicknessMismatch
            ? "Код 1С найден только для другой толщины; в счет без точной толщины из проекта не ставить."
          : layer.key === "pvc_logicroof_vrp" && !layer.thicknessMm
            ? "Количество мембраны рассчитано в м2; в счет не ставить, пока менеджер не уточнит толщину 1,2/1,5/1,8/2,0 мм и точную позицию 1С."
          : layer.key === "hydrowind_membrane" && !layer.searchTerms.length
              ? "Количество мембраны рассчитано в м2; в счет не ставить, пока менеджер не уточнит марку/тип и допустимость в этой кровельной системе."
          : requiresProjectQuantity
            ? `${layer.note ?? "Количество и тип воронок считать по проекту или калькулятору NAV.TN."} Код 1С найден, но количество воронок не распознано; в счет без подтвержденного количества не ставить.`
            : requiresMeasuredQuantity
              ? "Код 1С найден, но количество не рассчитано; в счет без площади/ведомости не ставить."
              : !layer.searchTerms.length && layer.note
                ? layer.note
                : "Код 1С не найден автоматически; в счет без ручной проверки не ставить.";

        notFound.push({
          role: layer.role,
          requestedLayer: layer.label,
          searchTerms: layer.searchTerms,
          calculation: quantity.text,
          note: missingReason,
          code: hasThicknessMismatch ? null : primary?.code ?? null,
          material: primary?.name ?? null,
          brand: primary?.brand ?? null,
          alternatives: matches.slice(1).map((item) => ({
            code: item.code,
            name: item.name,
            brand: item.brand,
          })),
        });
      }
    }

    if (roofDrainGuidance.shouldMention && !roofDrainGuidance.detectedInText) {
      notFound.push({
        role: "водоотвод/кровельные воронки",
        requestedLayer: "Кровельные воронки",
        searchTerms: roofDrainGuidance.searchTerms,
        calculation: "Количество считать по проекту водоотвода или калькулятору NAV.TN: нужен водосборный участок, населенный пункт, тип воронки и схема водоотвода.",
        note: "В PDF воронки не найдены, но для плоской кровли этот узел нужно обязательно проверить перед счетом.",
      });
    }

    const quoteItems = buildQuoteItems(invoiceItems);
    const analogRecommendations = await buildRoofAnalogRecommendations(layers, area);
    const quoteDraft = buildQuoteDraft({
      fileName: file.name,
      area,
      systemContext: projectSystem,
      quoteItems,
      invoiceItems,
      analogRecommendations,
      roofFastenerGuidance,
      notFound,
      projectOnly,
    });
    const detectedLayers = layers.map((layer) => ({
      role: layer.role,
      material: layer.label,
      quantityType: layer.quantityType,
      areaOverride: layer.areaOverride ?? null,
      quantityOverride: layer.quantityOverride ?? null,
      unitCount: layer.unitCount ?? null,
      note: layer.note ?? null,
    }));
    const projectEstimateLogId = await saveProjectEstimateLog({
      source: "project-upload",
      status: "estimated",
      file_name: file.name,
      direction,
      question,
      pages: parsed.numpages,
      chars: extractedText.length,
      area,
      ai_extraction: groundedAiExtraction,
      detected_layers: detectedLayers,
      invoice_items: invoiceItems,
      quote_items: quoteItems,
      quote_draft: quoteDraft,
      analog_recommendations: analogRecommendations,
      project_only: projectOnly,
      not_found: notFound,
      roof_fastener_guidance: roofFastenerGuidance,
      roof_drain_guidance: roofDrainGuidance,
    });

    return NextResponse.json({
      ok: true,
      projectEstimateLogId,
      fileName: file.name,
      chars: extractedText.length,
      pages: parsed.numpages,
      direction,
      question,
      projectQuery,
      area,
      detectedLayers,
      aiExtraction: groundedAiExtraction,
      invoiceItems,
      quoteItems,
      analogRecommendations,
      quoteDraft,
      projectSystem: isFullResponse ? projectSystem : compactProjectSystem(projectSystem),
      projectOnly,
      notFound,
      roofFastenerGuidance,
      roofDrainGuidance,
      textPreview: isFullResponse ? extractedText.slice(0, 1800) : undefined,
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error("project-estimate failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
