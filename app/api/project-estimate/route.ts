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

let localNomenclatureCache: NomenclatureItem[] | null = null;

type AreaInfo = {
  value: number | null;
  source: "manager_input" | "pdf_text" | "axes_estimate" | "not_found";
  confidence: "high" | "medium" | "low" | "none";
  note: string;
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
  note?: string;
  unitCount?: number;
  areaOverride?: number;
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

function round(value: number, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
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

  const roofSpecAreas = extractRoofSpecAreas(text);
  if (roofSpecAreas.membraneTotalArea > 0) {
    return {
      value: roofSpecAreas.membraneTotalArea,
      source: "pdf_text",
      confidence: "medium",
      note: roofSpecAreas.sandwichRoofArea > 0
        ? `Площадь мембранной кровли взята из спецификации кровельного покрытия. Отдельно найден тип кровли из сэндвич-панелей ${roofSpecAreas.sandwichRoofArea} м2; его считать отдельно по ведомости/номенклатуре.`
        : "Площадь мембранной кровли взята из спецификации кровельного покрытия.",
    };
  }

  const roofAreaPatterns = [
    new RegExp(`(?:площадь\\s+(?:кровли|покрытия))\\s*,?\\s*(?:м\\s*2|м2|м²|кв\\.?\\s*м)\\s*${NUMBER}`, "i"),
    new RegExp(`(?:площадь\\s+(?:кровли|покрытия)|s\\s*(?:кровли|покрытия))[^\\d]{0,30}${NUMBER}\\s*(?:м2|м²|кв\\.?\\s*м)`, "i"),
    new RegExp(`${NUMBER}\\s*(?:м2|м²|кв\\.?\\s*м)[^\\.]{0,40}(?:кровли|покрытия)`, "i"),
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
      };
    }
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
    const context = text.slice(Math.max(0, index - 160), index + 160);
    if (keywordPattern.test(context)) return Number(match[1]);
  }
  return undefined;
}

function detectParapetFunnelCount(text: string) {
  const matches = Array.from(text.matchAll(/спецификация парапетных воронок[\s\S]{0,500}?вп-1[\s\S]{0,300}?(\d{1,3})(?=\s+спецификация|\s+марка|\s+\d+\.\d|$)/gi));
  const total = matches.reduce((sum, match) => sum + Number(match[1] ?? 0), 0);
  return total > 0 ? total : undefined;
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

  for (const match of lower.matchAll(/технор[уо]ф\s*([вн])\s*(экстра|проф|оптима)\s*(\d{2,3})(?:\s*мм)?/gi)) {
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
  const xpsThicknessMatch = lower.match(/(?:xps|эппс|экструдированн[а-я\s-]*пенополистирол|пенополистирол)[^\d]{0,40}(\d{2,3})\s*мм/i);
  const xpsThicknessMm = xpsThicknessMatch?.[1] ? Number(xpsThicknessMatch[1]) : undefined;
  const roofSpecAreas = extractRoofSpecAreas(lower);
  const pvcMembraneThicknessMatch = lower.match(/logicroof\s+v-rp[\s\S]{0,80}?(\d(?:[,.]\d)?)\s*мм/i)
    ?? lower.match(/logicroof\s+v-rp[^\d]{0,40}(1[,.][258]|2[,.]0|2)/i)
    ?? lower.match(/(?:пвх[а-я\s-]*мембран|полимерн[а-я\s-]*мембран)[^\d]{0,50}(\d(?:[,.]\d)?)\s*мм/i);
  const pvcMembraneThicknessMm = pvcMembraneThicknessMatch?.[1] ? toNumber(pvcMembraneThicknessMatch[1]) : undefined;
  const roofWoolLayers = detectRoofWoolLayers(lower);
  const hasExternalRoofDrainage = includesAny(lower, [
    /наружн[а-я\s-]*организованн[а-я\s-]*водосток/i,
    /водосточн[а-я\s-]*желоб/i,
    /водосборн[а-я\s-]*воронк/i,
  ]);
  const hasParapetFunnel = includesAny(lower, [/воронк[а-я\s-]*парапет/i, /парапет[а-я\s-]*воронк/i]);
  const hasSquareParapetFunnel = hasParapetFunnel && /100\s*[xх*]\s*100\s*[xх*]\s*600/i.test(lower);
  const funnelUnitCount = hasParapetFunnel ? detectParapetFunnelCount(lower) ?? detectUnitCount(lower, /воронк[а-я]*/) : detectUnitCount(lower, /воронк[а-я]*/);

  const keramzitSlope = lower.match(/керамзит[а-я\s-]*грав[а-я\s-]*?(\d{2,3})\s*(?:\.{2,3}|-)\s*(\d{2,3})\s*мм/i);
  const keramzitAvg = keramzitSlope?.[1] && keramzitSlope?.[2]
    ? (Number(keramzitSlope[1]) + Number(keramzitSlope[2])) / 2
    : undefined;

  const layers: DetectedLayer[] = [
    {
      key: "pvc_logicroof_vrp",
      role: "кровельная ПВХ-мембрана",
      label: pvcMembraneThicknessMm ? `LOGICROOF V-RP ${pvcMembraneThicknessMm} мм` : "LOGICROOF V-RP",
      detected: includesAny(lower, [/logicroof\s+v-rp/i, /полимерн[а-я\s-]*мембран[а-я\s-]*logicroof/i]),
      searchTerms: pvcMembraneThicknessMm
        ? [`Logicroof V-RP ${String(pvcMembraneThicknessMm).replace(".", ",")}`, `Logicroof V-RP ${pvcMembraneThicknessMm}`, "ПВХ Logicroof V-RP"]
        : [],
      factor: 1.15,
      areaOverride: roofSpecAreas.membraneTotalArea > 0 ? roofSpecAreas.membraneTotalArea : undefined,
      quantityType: "m2",
      thicknessMm: pvcMembraneThicknessMm,
      note: pvcMembraneThicknessMm
        ? "Марку и толщину мембраны сверить по проекту перед КП."
        : "В проекте указана LOGICROOF V-RP без толщины; код 1С и счетную позицию ставить только после уточнения толщины 1,2/1,5/1,8/2,0 мм.",
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
    ...roofWoolLayers,
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
      key: "technobarrier",
      role: "пароизоляция",
      label: "ТЕХНОБАРЬЕР / Паробарьер C",
      detected: includesAny(lower, [/технобарьер/i, /паробарьер\s*с/i]),
      searchTerms: ["ТЕХНОБАРЬЕР", "Паробарьер C", "Паробарьер"],
      factor: 1.12,
      areaOverride: roofSpecAreas.membraneTotalArea > 0 ? roofSpecAreas.membraneTotalArea : undefined,
      quantityType: "m2",
      note: "Марку пароизоляции сверить: в разных местах проекта указаны ТЕХНОБАРЬЕР и Паробарьер C.",
    },
    {
      key: "hydrowind_membrane",
      role: "гидроветрозащитная мембрана",
      label: "Гидроветрозащитная мембрана",
      detected: includesAny(lower, [/гидро\s*ветрозащитн[а-я\s-]*мембран/i, /гидроветрозащитн[а-я\s-]*мембран/i]),
      searchTerms: ["Гидроветрозащитная мембрана", "Гидро-ветрозащитная мембрана", "Ветрозащитная мембрана"],
      factor: 1.15,
      quantityType: "m2",
      note: "Тип мембраны и допустимость применения в кровельном пироге сверить по проекту/системе.",
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
      label: xpsThicknessMm ? `XPS ${xpsThicknessMm} мм` : "XPS",
      detected: includesAny(lower, [/xps/i, /эппс/i, /экструдированн[а-я\s-]*пенополистирол/i]),
      searchTerms: xpsThicknessMm
        ? [`CARBON ECO ${xpsThicknessMm}`, `CARBON PROF ${xpsThicknessMm}`, `XPS ${xpsThicknessMm}`, `ЭППС ${xpsThicknessMm}`]
        : ["CARBON ECO", "CARBON PROF", "XPS", "ЭППС"],
      factor: 1.03,
      thicknessMm: xpsThicknessMm,
      quantityType: xpsThicknessMm ? "m3" : "m2",
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
      key: hasParapetFunnel ? "roof_funnel_parapet" : "roof_funnel",
      role: "водоотвод/кровельная воронка",
      label: hasSquareParapetFunnel ? "Воронка парапетная квадратного сечения с галтелью 100х100х600" : hasParapetFunnel ? "Воронка парапетная" : "Воронка кровельная",
      detected: (!hasExternalRoofDrainage || hasParapetFunnel) && includesAny(lower, [/воронк[а-я]*/i, /водосточн[а-я\s-]*воронк/i, /внутренн[а-я\s-]*водост/i]),
      searchTerms: hasParapetFunnel
        ? hasSquareParapetFunnel
          ? ["Воронка парапетная ТехноНИКОЛЬ квадратного сечения с галтелью 100*100*600", "Воронка парапетная ТехноНИКОЛЬ", "Воронка парапетная"]
          : ["Воронка парапетная ТехноНИКОЛЬ", "Воронка парапетная"]
        : ["Воронка ТехноНИКОЛЬ", "Воронка кровельная", "Воронка с обжимным фланцем"],
      quantityType: "project",
      unitCount: funnelUnitCount,
      note: "Количество и тип воронок считать по проекту или калькулятору NAV.TN; в счет ставить только после подтверждения водосборных участков.",
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

function aiLayerArea(layer: ProjectAiLayer) {
  if (!layer.areaM2 || layer.areaM2 <= 0) return undefined;
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
    const text = `${role} ${material} ${layer.note ?? ""}`.toLowerCase();
    const thicknessMm = layer.thicknessMm ?? parseAiThickness(text);
    const areaOverride = aiLayerArea(layer);
    const note = aiLayerNote(layer);
    const isProjectOnly = Boolean(layer.projectOnly);
    const unitCount = (layer.unit === "шт" || layer.quantityType === "шт") && layer.quantity ? layer.quantity : undefined;

    if (/logicroof\s+v-rp|пвх[а-я\s-]*мембран/.test(text)) {
      return {
        key: "pvc_logicroof_vrp",
        role: "кровельная ПВХ-мембрана",
        label: thicknessMm ? `LOGICROOF V-RP ${thicknessMm} мм` : material || "LOGICROOF V-RP",
        detected: true,
        searchTerms: thicknessMm
          ? [`Logicroof V-RP ${String(thicknessMm).replace(".", ",")}`, `Logicroof V-RP ${thicknessMm}`, "ПВХ Logicroof V-RP"]
          : ["ПВХ Logicroof V-RP", "Logicroof V-RP"],
        factor: 1.15,
        thicknessMm,
        areaOverride,
        quantityType: "m2",
        note,
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
  if (key === "technobarrier") return "technobarrier";
  if (key === "uniflex_epp") return "uniflex_epp";
  if (key === "technoelast_epp") return "technoelast_epp";
  if (key === "technoelast_ekp") return "technoelast_ekp";
  if (key === "pergamin") return "pergamin";
  if (key === "primer_08") return "primer_08";
  if (key.includes("logicpir_slope") || text.includes("logicpir slope")) return "logicpir_slope";
  if (key.includes("roof_funnel") || text.includes("воронк")) return "roof_funnel";
  if (key.includes("logicpir_prof") || text.includes("logicpir prof")) return `logicpir_prof_${layer.thicknessMm ?? parseAiThickness(text) ?? "unknown"}`;
  if (key.includes("technoruf") || text.includes("техноруф")) return `technoruf_${layer.thicknessMm ?? parseAiThickness(text) ?? "unknown"}`;
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
      unitCount: existing.unitCount ?? aiLayer.unitCount,
      note: existing.note ?? aiLayer.note,
    });
  }
  return Array.from(merged.values());
}

function buildRoofFastenerGuidance(text: string, question: string) {
  const signalText = `${text} ${question}`.toLowerCase();
  const asksAboutFasteners = /креп[её]ж|саморез|телескоп|termoclip|термоклип|анкер/i.test(signalText);
  const looksLikeMechanicallyFixedRoof = /пвх|logicroof|мембран|механическ/i.test(signalText) && /кровл|профлист|основан|утепл/i.test(signalText);
  const shouldMention = asksAboutFasteners || looksLikeMechanicallyFixedRoof;

  return {
    shouldMention,
    source: "правило из консультации специалиста, 2026-05-25",
    scope: "механическое крепление мембраны/утеплителя в кровельных системах",
    rules: [
      "Крепеж подбирается по общей толщине теплоизоляции и типу основания.",
      "Комплект для мембраны: телескопический крепеж + саморез; для бетонного основания дополнительно нужен нейлоновый дюбель/анкерный элемент.",
      "Для профлиста применяется сверлоконечный саморез; для бетона — остроконечный саморез в дюбель/анкер после засверливания.",
      "Пример из консультации: при 150 мм утепления нужен телескопический крепеж 120 мм и саморез 70 мм.",
      "Основное поле мембраны: ориентир 6 комплектов/м2, то есть 6 телескопов + 6 саморезов на м2.",
      "Предварительное крепление теплоизоляции: минимум 2 крепежа/м2.",
      "Предварительный полный ориентир для поля: 8 крепежей/м2, но не как финальный ветровой расчет.",
      "Краевые, периметральные и угловые ветровые зоны рассчитываются отдельно и могут требовать больше крепежа.",
    ],
    preliminaryRates: {
      insulationFastenersPerM2: 2,
      membraneFieldKitsPerM2: 6,
      totalFieldFastenersPerM2: 8,
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
  if (layer.key === "pvc_logicroof_vrp" && layer.thicknessMm) {
    const desiredThickness = String(layer.thicknessMm).replace(".", "[,.]");
    const hasDesiredThickness = new RegExp(`${desiredThickness}\\s*(?:мм|mm)?`).test(name);
    const itemThickness = name.match(/(?:^|\s)(1[,.][258]|2[,.]0)\s*(?:мм|mm)?/i)?.[1]?.replace(",", ".");
    if (hasDesiredThickness) score += 30;
    if (itemThickness && itemThickness !== String(layer.thicknessMm)) score -= 20;
  }
  if (layer.key === "pvc_logicroof_vrp" && /arctic|arctiс/i.test(item.name ?? "") && !/arctic|arctiс/i.test(requested)) score -= 20;
  if (layer.key === "pvc_logicroof_vrp" && /2[,.]10\s*[xх]\s*20/i.test(item.name ?? "")) score += 4;
  if (layer.key === "xps" && /carbon eco/i.test(item.name ?? "")) score += 7;
  if (layer.key === "xps" && /carbon prof/i.test(item.name ?? "")) score += 5;
  if (layer.key.startsWith("logicpir_prof") && /logicpir/i.test(item.name ?? "") && /prof/i.test(item.name ?? "")) score += 16;
  if (layer.key.startsWith("logicpir_prof") && /ф\/ф|f\/f/i.test(item.name ?? "")) score += 8;
  if (layer.key.includes("_40") && /40\b|40\s*мм/i.test(item.name ?? "")) score += 10;
  if (layer.key.includes("_70") && /70\b|70\s*мм/i.test(item.name ?? "")) score += 10;
  if (layer.key === "technobarrier" && /технобарьер|паробарьер/i.test(item.name ?? "")) score += 14;
  if (layer.key === "technoruf_n_prof_100_spec" && /технор[уо]ф/i.test(item.name ?? "")) score += 14;
  if (layer.key === "technoruf_n_prof_100_spec" && /н\s*(?:проф|30)|н30/i.test(item.name ?? "")) score += 10;
  if (layer.key.startsWith("technoruf_") && /технор[уо]ф/i.test(item.name ?? "")) score += 14;
  if (layer.key.includes("_экстра_") && /в\s*экстра/i.test(item.name ?? "")) score += 18;
  if (layer.key.includes("_проф_") && /н\s*проф/i.test(item.name ?? "")) score += 18;
  if (layer.key.includes("_оптима_") && /(?:в|н)\s*оптима/i.test(item.name ?? "")) score += 14;
  if (layer.key.includes("_в60_") && /в\s*60|в60/i.test(item.name ?? "")) score += 14;
  if (layer.key.includes("_н30_") && /н\s*30|н30|h30/i.test(item.name ?? "")) score += 14;
  if (layer.key === "hydrowind_membrane" && /гидро.?ветрозащит|ветрозащит/i.test(item.name ?? "")) score += 14;
  if (layer.key === "keramzit_slope" && /20-40|20\/40/i.test(item.name ?? "")) score += 4;
  if (layer.key.startsWith("roof_funnel") && /воронк/i.test(item.name ?? "")) score += 18;
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

async function findNomenclature(layer: DetectedLayer) {
  if (!layer.searchTerms.length || layer.projectOnly) return [];
  const supabase = getServiceSupabase();
  const found = new Map<string, NomenclatureItem>();
  let hadSupabaseError = false;

  for (const term of layer.searchTerms) {
    const { data, error } = await supabase
      .from("nomenclature_1c")
      .select("code,name,brand")
      .ilike("name", buildSearchPattern(term))
      .limit(10);

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

  const supabaseResult = Array.from(found.values())
    .sort((a, b) => itemScore(b, layer) - itemScore(a, layer))
    .slice(0, 3);

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
    .slice(0, 3);
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

function buildQuantity(layer: DetectedLayer, area: AreaInfo, item: NomenclatureItem | null) {
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
    const rollArea = parseRollArea(item?.name ?? null);
    const rolls = rollArea !== null ? Math.ceil(qty / rollArea) : null;
    return {
      value: round(qty, 2),
      text: rolls !== null && rollArea !== null
        ? `${round(qty, 2)} м2, ориентир ${rolls} рул. по ${round(rollArea, 2)} м2`
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

function buildProjectQuery(summary: {
  direction: string;
  question: string;
  area: AreaInfo;
  layers: DetectedLayer[];
}) {
  const layerText = summary.layers.map((layer) => layer.label).join("; ");
  return [
    `Проект ${summary.direction || "кровля"}`,
    summary.question,
    summary.area.value ? `площадь ${summary.area.value} м2` : "",
    layerText,
    "подбери материалы с кодами 1С, коды не придумывать",
  ]
    .filter(Boolean)
    .join(". ");
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

function buildQuoteDraft(summary: {
  fileName: string;
  area: AreaInfo;
  quoteItems: QuoteItem[];
  notFound: ReviewItem[];
  projectOnly: Array<{ role: string; material: string; note?: string }>;
}) {
  const lines: string[] = [];
  lines.push(`Черновик КП без цен: ${summary.fileName}`);
  lines.push(`Площадь: ${summary.area.value ? `${summary.area.value} м2 (${summary.area.source})` : "не найдена"}`);
  lines.push("");

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
        area = {
          value: round(groundedAiExtraction.roofAreaM2, 2),
          source: "pdf_text",
          confidence: groundedAiExtraction.roofAreaConfidence === "high" ? "high" : "medium",
          note: `Площадь кровли извлечена AI-экстрактором из PDF. ${groundedAiExtraction.roofAreaSource ?? "Перед счетом сверить с ведомостью/планом кровли."}`,
        };
      }
    }

    const roofFastenerGuidance = buildRoofFastenerGuidance(extractedText, question);
    const roofDrainGuidance = buildRoofDrainGuidance(extractedText, question, layers);
    const projectQuery = buildProjectQuery({ direction, question, area, layers });

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

      if (primary?.code && !requiresProjectQuantity && !requiresMeasuredQuantity) {
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
        const missingReason = requiresProjectQuantity
          ? "Код 1С найден, но количество воронок не распознано; в счет без проекта водоотвода или калькулятора NAV.TN не ставить."
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
          code: primary?.code ?? null,
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
    const quoteDraft = buildQuoteDraft({
      fileName: file.name,
      area,
      quoteItems,
      notFound,
      projectOnly,
    });
    const detectedLayers = layers.map((layer) => ({
      role: layer.role,
      material: layer.label,
      quantityType: layer.quantityType,
      areaOverride: layer.areaOverride ?? null,
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
      quoteDraft,
      projectOnly,
      notFound,
      roofFastenerGuidance,
      roofDrainGuidance,
      textPreview: extractedText.slice(0, 1800),
    });
  } catch (error) {
    const message = errorMessage(error);
    console.error("project-estimate failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
