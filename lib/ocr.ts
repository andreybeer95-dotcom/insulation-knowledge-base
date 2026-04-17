export async function extractTextWithOCR(pdfBuffer: Buffer): Promise<string> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_VISION_API_KEY не задан");

  const base64Pdf = pdfBuffer.toString("base64");

  const response = await fetch(
    `https://vision.googleapis.com/v1/files:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{
          inputConfig: {
            content: base64Pdf,
            mimeType: "application/pdf"
          },
          features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          imageContext: {
            languageHints: ["ru", "en"]
          },
          pages: [1, 2, 3, 4, 5]
        }]
      })
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Google Vision API error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as any;

  const allText: string[] = [];
  const responses = data.responses ?? [];

  for (const pageResponse of responses) {
    if (pageResponse.error) {
      console.error("Vision page error:", pageResponse.error);
      continue;
    }
    const text = pageResponse.fullTextAnnotation?.text ?? "";
    if (text.trim()) allText.push(text.trim());
  }

  return allText.join("\n\n--- Страница ---\n\n");
}

