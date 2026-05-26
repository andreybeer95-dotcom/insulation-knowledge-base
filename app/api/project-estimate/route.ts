import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";

import { getServiceSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type NomenclatureItem = {
  code: string | null;
  name: string | null;
  brand: string | null;
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

function detectLayers(text: string, question = ""): DetectedLayer[] {
  const lower = `${text} ${question}`.toLowerCase();
  const xpsThicknessMatch = lower.match(/(?:xps|эппс|экструдированн[а-я\s-]*пенополистирол|пенополистирол)[^\d]{0,40}(\d{2,3})\s*мм/i);
  const xpsThicknessMm = xpsThicknessMatch?.[1] ? Number(xpsThicknessMatch[1]) : undefined;
  const hasParapetFunnel = includesAny(lower, [/воронк[а-я\s-]*парапет/i, /парапет[а-я\s-]*воронк/i]);
  const hasSquareParapetFunnel = hasParapetFunnel && /100\s*[xх*]\s*100\s*[xх*]\s*600/i.test(lower);
  const funnelUnitCount = detectUnitCount(lower, /воронк[а-я]*/);

  const keramzitSlope = lower.match(/керамзит[а-я\s-]*грав[а-я\s-]*?(\d{2,3})\s*(?:\.{2,3}|-)\s*(\d{2,3})\s*мм/i);
  const keramzitAvg = keramzitSlope?.[1] && keramzitSlope?.[2]
    ? (Number(keramzitSlope[1]) + Number(keramzitSlope[2])) / 2
    : undefined;

  const layers: DetectedLayer[] = [
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
      key: hasParapetFunnel ? "roof_funnel_parapet" : "roof_funnel",
      role: "водоотвод/кровельная воронка",
      label: hasSquareParapetFunnel ? "Воронка парапетная квадратного сечения с галтелью 100х100х600" : hasParapetFunnel ? "Воронка парапетная" : "Воронка кровельная",
      detected: includesAny(lower, [/воронк[а-я]*/i, /водосточн[а-я\s-]*воронк/i, /внутренн[а-я\s-]*водост/i]),
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
  const detectedInText = /воронк|водосточн[а-я\s-]*воронк|внутренн[а-я\s-]*водост/i.test(text.toLowerCase());
  const asksAboutDrains = /воронк|водосток|водоотвод|ливнев/i.test(signalText);
  const looksLikeFlatRoof = layers.some((layer) =>
    ["uniflex_epp", "technoelast_epp", "technoelast_ekp", "keramzit_slope", "pergamin"].includes(layer.key)
  );

  return {
    shouldMention: asksAboutDrains || looksLikeFlatRoof,
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
  if (layer.key === "xps" && /carbon eco/i.test(item.name ?? "")) score += 7;
  if (layer.key === "xps" && /carbon prof/i.test(item.name ?? "")) score += 5;
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
  const matches = Array.from(name.matchAll(/(\d+(?:[,.]\d+)?)\s*(?:м3|м³)/gi));
  if (!matches.length) return null;
  const last = matches[matches.length - 1]?.[1];
  if (!last) return null;
  const value = toNumber(last);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function buildQuantity(layer: DetectedLayer, area: AreaInfo, item: NomenclatureItem | null) {
  if (layer.quantityType === "project") {
    return {
      value: null,
      text: layer.unitCount ? `${layer.unitCount} шт по проекту/задаче менеджера; тип воронки сверить по проекту водоотвода.` : layer.note ?? "Расход по проекту.",
    };
  }

  if (!area.value) {
    return {
      value: null,
      text: "Площадь кровли не найдена; количество не рассчитано.",
    };
  }

  if (layer.quantityType === "m2") {
    const qty = area.value * (layer.factor ?? 1);
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
    const qty = area.value * (layer.thicknessMm / 1000) * (layer.factor ?? 1);
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
      text: `${round(qty, 3)} м3 (${round(area.value * (layer.factor ?? 1), 2)} м2 x ${layer.thicknessMm} мм)`,
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

    const area = detectRoofArea(extractedText, manualArea);
    const layers = detectLayers(extractedText, question);
    const roofFastenerGuidance = buildRoofFastenerGuidance(extractedText, question);
    const roofDrainGuidance = buildRoofDrainGuidance(extractedText, question, layers);
    const projectQuery = buildProjectQuery({ direction, question, area, layers });

    const invoiceItems = [];
    const notFound = [];
    const projectOnly = [];

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

      if (primary?.code) {
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
        notFound.push({
          role: layer.role,
          requestedLayer: layer.label,
          searchTerms: layer.searchTerms,
          calculation: quantity.text,
          note: "Код 1С не найден автоматически; в счет без ручной проверки не ставить.",
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

    return NextResponse.json({
      ok: true,
      fileName: file.name,
      chars: extractedText.length,
      pages: parsed.numpages,
      direction,
      question,
      projectQuery,
      area,
      detectedLayers: layers.map((layer) => ({
        role: layer.role,
        material: layer.label,
        quantityType: layer.quantityType,
        note: layer.note ?? null,
      })),
      invoiceItems,
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
