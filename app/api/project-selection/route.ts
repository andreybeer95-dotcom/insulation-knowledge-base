import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function buildCompactSummary(estimate: any) {
  if (typeof estimate?.quoteDraft === "string" && estimate.quoteDraft.trim()) {
    return estimate.quoteDraft;
  }

  const lines: string[] = [];
  lines.push(`Файл: ${estimate?.fileName ?? "PDF проекта"}`);
  if (estimate?.area?.value) {
    lines.push(`Площадь: ${estimate.area.value} м2 (${estimate.area.source})`);
  }
  if (estimate?.invoiceItems?.length) {
    lines.push("В счет:");
    for (const item of estimate.invoiceItems) {
      lines.push(`- ${item.role}: ${item.material} | ${item.code} | ${item.calculation}`);
    }
  }
  if (estimate?.projectOnly?.length) {
    lines.push("Проектные слои:");
    for (const item of estimate.projectOnly) {
      lines.push(`- ${item.role}: ${item.material}`);
    }
  }
  if (estimate?.notFound?.length) {
    lines.push("Требует проверки:");
    for (const item of estimate.notFound) {
      const code = item.code ? ` | ${item.code}` : "";
      const material =
        item.material && item.material !== item.requestedLayer ? ` -> ${item.material}` : "";
      lines.push(`- ${item.role}: ${item.requestedLayer}${material}${code}`);
    }
  }
  if (estimate?.roofFastenerGuidance?.shouldMention) {
    lines.push("Крепеж (если система с механическим креплением):");
    lines.push("- поле мембраны: ориентир 6 комплектов/м2 (телескоп + саморез);");
    lines.push("- теплоизоляция: минимум 2 крепежа/м2;");
    lines.push("- полный предварительный ориентир: 8 крепежей/м2;");
    lines.push("- профильный лист: сверлоконечный саморез; бетон: остроконечный саморез + дюбель/анкер;");
    lines.push("- краевые и угловые ветровые зоны считать отдельно.");
  }
  if (estimate?.roofDrainGuidance?.shouldMention) {
    if (estimate.roofDrainGuidance.detectedInText) {
      lines.push("Воронки: найдены в проекте; количество/тип сверить по проекту водоотвода или калькулятору NAV.TN.");
    } else {
      lines.push("Воронки: в PDF не найдены; для плоской кровли проверить водоотвод и посчитать через проект или калькулятор NAV.TN.");
    }
  }
  return lines.join("\n");
}

function sanitizeEstimateForSelection(estimate: any) {
  if (!estimate || typeof estimate !== "object") return estimate;
  const { textPreview: _textPreview, projectSystem, ...rest } = estimate;
  const compactSystem = projectSystem && typeof projectSystem === "object"
    ? {
      id: projectSystem.id ?? null,
      name: projectSystem.name ?? null,
      source: projectSystem.source ?? null,
      confidence: projectSystem.confidence ?? null,
      reason: projectSystem.reason ?? null,
      navAnalogName: projectSystem.navAnalogName ?? null,
      warning: projectSystem.warning ?? null,
      rulesCount: Array.isArray(projectSystem.rules) ? projectSystem.rules.length : projectSystem.rulesCount ?? 0,
      ruleNames: Array.isArray(projectSystem.ruleNames)
        ? projectSystem.ruleNames.slice(0, 8)
        : Array.isArray(projectSystem.rules)
          ? projectSystem.rules.map((rule: any) => rule?.rule_name).filter(Boolean).slice(0, 8)
          : [],
    }
    : projectSystem;
  return { ...rest, projectSystem: compactSystem };
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const estimate = sanitizeEstimateForSelection(body?.estimate);

    if (!estimate) {
      return NextResponse.json({ ok: false, message: "estimate is required" }, { status: 400 });
    }

    const webhookUrl =
      process.env.PROJECT_SELECTION_WEBHOOK_URL ||
      process.env.N8N_PROJECT_SELECTION_WEBHOOK_URL ||
      "";

    const compactSummary = buildCompactSummary(estimate);
    const payload = {
      event: "project_estimate_ready",
      source: "project-upload",
      createdAt: new Date().toISOString(),
      managerComment: body?.comment ?? "",
      compactSummary,
      quoteDraft: estimate?.quoteDraft ?? compactSummary,
      quoteItems: estimate?.quoteItems ?? [],
      estimate,
    };

    if (!webhookUrl) {
      return NextResponse.json(
        {
          ok: false,
          status: "not_configured",
          message: "Канал подбора пока не подключен. Расчет готов, используйте таблицу ниже; отправку в подбор подключим отдельным webhook.",
          setupHint: "Set PROJECT_SELECTION_WEBHOOK_URL or N8N_PROJECT_SELECTION_WEBHOOK_URL.",
          payloadPreview: payload,
        },
        { status: 202 }
      );
    }

    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return NextResponse.json(
        {
          ok: false,
          status: "webhook_error",
          message: `Подбор не принял заявку: HTTP ${response.status}`,
          details: text.slice(0, 1000),
        },
        { status: 502 }
      );
    }

    return NextResponse.json({ ok: true, status: "sent", message: "Расчет отправлен в подбор." });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, message }, { status: 500 });
  }
}
