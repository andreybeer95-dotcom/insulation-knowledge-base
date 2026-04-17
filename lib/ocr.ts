import { fromBuffer } from "pdf2pic";
import fs from "fs";
import os from "os";
import path from "path";

export async function extractTextWithOCR(pdfBuffer: Buffer): Promise<string> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_VISION_API_KEY не задан");

  const tmpDir = os.tmpdir();
  const outputPrefix = path.join(tmpDir, `ocr_${Date.now()}`);
  void outputPrefix;

  // Конвертируем PDF страницы в PNG изображения
  const convert = fromBuffer(pdfBuffer, {
    density: 200,
    saveFilename: "page",
    savePath: tmpDir,
    format: "png",
    width: 1700,
    height: 2200
  });

  let pageNum = 1;
  const allText: string[] = [];

  // Обрабатываем страницы пока они есть (максимум 20)
  while (pageNum <= 20) {
    let result;
    try {
      result = await convert(pageNum);
    } catch {
      break;
    }

    if (!result?.path || !fs.existsSync(result.path)) break;

    try {
      // Читаем PNG и конвертируем в base64
      const imageBuffer = fs.readFileSync(result.path);
      const base64Image = imageBuffer.toString("base64");

      // Отправляем в Google Vision API
      const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requests: [
            {
              image: { content: base64Image },
              features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
              imageContext: { languageHints: ["ru", "en"] }
            }
          ]
        })
      });

      const data = await response.json();
      const text = data.responses?.[0]?.fullTextAnnotation?.text ?? "";
      if (text.trim()) allText.push(text.trim());
    } finally {
      // Удаляем временный файл
      try {
        fs.unlinkSync(result.path);
      } catch {}
    }

    pageNum++;
  }

  return allText.join("\n\n--- Страница ---\n\n");
}

