import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function buildCompactSummary(estimate: any) {
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
      lines.push(`- ${item.role}: ${item.requestedLayer}`);
    }
  }
  return lines.join("\n");
}

function sanitizeEstimateForSelection(estimate: any) {
  if (!estimate || typeof estimate !== "object") return estimate;
  const { textPreview: _textPreview, ...rest } = estimate;
  return rest;
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

    const payload = {
      event: "project_estimate_ready",
      source: "project-upload",
      createdAt: new Date().toISOString(),
      managerComment: body?.comment ?? "",
      compactSummary: buildCompactSummary(estimate),
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
