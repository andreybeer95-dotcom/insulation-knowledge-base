import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getServiceSupabase } from "@/lib/server-supabase";
import crypto from "crypto";

export const maxDuration = 60;

function detectDocType(fileName: string): string {
  const name = fileName.toLowerCase();
  if (name.includes("тех") && (name.includes("описание") || name.includes("лист"))) return "tds";
  if (name.includes("сертификат пожарн")) return "сертификат";
  if (name.includes("сертификат соответ")) return "сертификат";
  if (name.includes("декларация")) return "сертификат";
  if (name.includes("свидетельство") || name.includes("санпин") || name.includes("сан")) return "сертификат";
  if (name.includes("отказное письмо")) return "сертификат";
  if (name.includes("письмо мчс")) return "сертификат";
  if (name.includes("прайс") || name.includes("price")) return "прайс";
  if (name.includes("инструкц") || name.includes("монтаж")) return "инструкция";
  if (name.includes("каталог")) return "tds";
  return "tds"; // по умолчанию
}

async function detectManufacturer(fileName: string, supabase: any): Promise<string | null> {
  const name = fileName.toLowerCase();
  
  const brandKeywords: Record<string, string[]> = {
    'Церезит': ['церезит', 'ceresit', 'см 11', 'см 14', 'см 16', 'ст 83', 'ст 180', 'cr 65', 'cr65', 'cr65'],
    'Плитонит': ['плитонит', 'plitонit', 'plitosil', 'плитосил'],
    'Основит': [
      'основит', 'osnovit',
      'ekstervell', 'экстервелл', 'экстервэлл',
      'startvell', 'стартвелл',
      'gipsvell', 'гипсвелл',
      'kaverpliks', 'каверпликс',
      'univita', 'унивита',
      'selform', 'селформ',
      'tekhnoplast', 'технопласт',
    ],
    'Индастро': ['индастро', 'indastro', 'профскрин', 'rc45'],
    'Веккерле': ['веккерле', 'vekkerle', 'цпс', 'цемент м500'],
    'ЭКОРОЛЛ': ['экоролл', 'ekoroll', 'кв-', 'кв80', 'кв100'],
    'XOTPIPE': ['xotpipe', 'хотпайп', 'bos-pipe', 'bos pipe'],
    'ROCKWOOL': ['rockwool', 'роквул', 'rwl', 'sp alu'],
    'CUTWOOL': ['cutwool', 'катвул'],
    'ISOTEC': ['isotec', 'изотек', 'shell', 'section al'],
    'ПРЕСТОРУСЬ': ['престорусь', 'prestorus', 'стабарм', 'stabarm', 'георешетка', 'presto.ru'],
    'АРМОСТАБ': ['армостаб', 'armostab', 'армостаб ар2п', 'армостаб асфальт'],
    'ЮниФенс': ['юнифенс', 'unifence', 'unifens'],
    "ТЕХНОНИКОЛЬ": ["технониколь", "technonicol", "технофас", "техновент", "техноруф", "технолайт", "техноблок", "carbon prof", "carbon eco", "logicpir", "роклайт", "изовол", "izovol"],
    "BASWOOL": ["baswool", "басвул"],
    "ЗИКА": ["sika", "зика", "sikaplan", "sikafloor", "sikaemaco"],
    "ПЕНОПЛЭКС": ["пеноплэкс", "penoplex", "plastfoil"],
    "HOTROCK": ["hotrock", "хотрок"],
  };
  
  for (const [brandName, keywords] of Object.entries(brandKeywords)) {
    if (keywords.some(kw => name.includes(kw))) {
      const { data } = await supabase
        .from('manufacturers')
        .select('id')
        .ilike('name_ru', brandName)
        .single();
      if (data) return data.id;
    }
  }
  return null;
}

async function detectManufacturerFromContent(
  text: string,
  supabase: ReturnType<typeof getServiceSupabase>
): Promise<string | null> {
  const contentLower = text.toLowerCase().slice(0, 3000);

  const contentBrands: Record<string, string[]> = {
    "Индастро": ["индастро", "indastro", "профскрин", "profskrin", "rc45"],
    "Основит": ["основит", "osnovit", "ekstervell", "startvell", "gipsvell",
      "kaverpliks", "univita", "selform", "skorlayn", "rovilayn",
      "eksterkont", "unkont", "niplayn", "seyfskrin"],
    "Церезит": ["церезит", "ceresit", "henkel", "лаб индастриз"],
    "Плитонит": ["плитонит", "plitonit", "plitosil", "nafufill"],
    "Веккерле": ["веккерле", "vekkerle", "цпс", "цемент м500"],
    "XOTPIPE": ["xotpipe", "хотпайп", "хотрipe", "bos-pipe"],
    "ЭКОРОЛЛ": ["экоролл", "ekoroll", "катвул", "cutwool", "кв-80", "кв-100"],
    "ROCKWOOL": ["rockwool", "роквул", "rockwool"],
    "ISOTEC": ["isotec", "изотек", "section al"],
    "CUTWOOL": ["cutwool", "катвул"],
    "ПРЕСТОРУСЬ": ["престорусь", "prestorus", "стабарм", "stabarm", "георешетка", "presto.ru"],
    "АРМОСТАБ": ["армостаб", "armostab", "армостаб ар2п", "армостаб асфальт"],
    "ЮниФенс": ["юнифенс", "unifence", "unifens"],
    "ТЕХНОНИКОЛЬ": ["технониколь", "technonicol", "технофас", "техновент", "техноруф", "технолайт", "техноблок", "carbon prof", "carbon eco", "logicpir", "роклайт", "изовол", "izovol"],
    "BASWOOL": ["baswool", "басвул"],
    "ЗИКА": ["sika", "зика", "sikaplan", "sikafloor", "sikaemaco"],
    "ПЕНОПЛЭКС": ["пеноплэкс", "penoplex", "plastfoil"],
    "HOTROCK": ["hotrock", "хотрок"],
    "ИКОПАЛ": ["икопал", "icopal", "виллафлекс", "виллатекс", "виллаэласт", "вилладрейн", "ультранап", "монарплан", "синтан"],
  };

  for (const [brandName, keywords] of Object.entries(contentBrands)) {
    if (keywords.some((kw) => contentLower.includes(kw))) {
      const { data } = await supabase
        .from("manufacturers")
        .select("id")
        .ilike("name_ru", brandName)
        .single();
      if (data) return data.id;
    }
  }
  return null;
}

export async function GET() {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("documents")
    .select("id, title, doc_type, file_url, file_name, manufacturer_id, notes, created_at, manufacturers(name_ru), document_chunks(count)")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const documents = (data ?? []).map((d: any) => ({
    ...d,
    chunks_count: d.document_chunks?.[0]?.count ?? 0
  }));
  return NextResponse.json({ documents });
}

export async function POST(request: NextRequest) {
  console.log("=== UPLOAD START ===", new Date().toISOString());
  const supabase = createClient();
  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await request.formData();
    const file = formData.get("file") as File;
    const title = (formData.get("title") || formData.get("name") || "") as string;
    let manufacturer_id = formData.get("manufacturer_id") as string | null || null;
    if (!manufacturer_id) {
      manufacturer_id = await detectManufacturer(file.name, supabase);
      if (manufacturer_id) {
        console.log(`🏭 Автоопределён производитель для: ${file.name}`);
      }
    }
    const product_id = formData.get("product_id") as string | null;
    const doc_type_raw = formData.get("doc_type") as string || '';
    const fileName_orig = file.name;

    // Если тип не передан — определяем автоматически по имени файла
    let doc_type_ru: string;
    if (doc_type_raw && doc_type_raw !== "tds") {
      const DOC_TYPE_MAP: Record<string, string> = {
        tds: "техлист", script: "инструкция", compare: "техлист",
        norm: "техлист", install: "инструкция", price: "прайс",
        certificate: "сертификат", addition: "дополнение",
      };
      doc_type_ru = DOC_TYPE_MAP[doc_type_raw] ?? "техлист";
    } else {
      // Автоопределение по имени файла
      const autoType = detectDocType(fileName_orig);
      const AUTO_MAP: Record<string, string> = {
        'tds': 'техлист', 'сертификат': 'сертификат',
        'прайс': 'прайс', 'инструкция': 'инструкция'
      };
      doc_type_ru = AUTO_MAP[autoType] ?? 'техлист';
      console.log(`🔍 Автоопределение типа: ${fileName_orig} → ${doc_type_ru}`);
    }
    const priority_weight = Number(formData.get("priority_weight") || 0) || null;
    const intent_tags_raw = (formData.get("intent_tags") || "[]") as string;
    let intent_tags: string[] = [];
    try {
      const parsed = JSON.parse(intent_tags_raw);
      if (Array.isArray(parsed)) intent_tags = parsed.filter((x) => typeof x === "string");
    } catch {
      intent_tags = [];
    }

    if (!file) return NextResponse.json({ error: "Файл не передан" }, { status: 400 });

    const fileName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const fileHash = crypto.createHash("md5").update(buffer).digest("hex");

    const { data: existing } = await supabase
      .from("documents")
      .select("id, title")
      .eq("file_hash", fileHash)
      .single();

    if (existing) {
      return NextResponse.json(
        {
          success: false,
          duplicate: true,
          existing_id: existing.id,
          existing_title: existing.title,
          warning: `Файл уже загружен как "${existing.title}"`
        },
        { status: 409 }
      );
    }

    const { error: storageError } = await supabase.storage
      .from("documents")
      .upload(fileName, buffer, { contentType: "application/pdf", upsert: false });

    if (storageError) {
      return NextResponse.json({ error: "Ошибка Storage: " + storageError.message }, { status: 500 });
    }

    const { data: urlData } = supabase.storage.from("documents").getPublicUrl(fileName);

    const { data: doc, error: dbError } = await supabase
      .from("documents")
      .insert({
        title: title || file.name.replace(".pdf", ""),
        file_name: fileName,
        file_url: urlData.publicUrl,
        manufacturer_id: manufacturer_id || null,
        product_id: product_id || null,
        file_hash: fileHash,
        doc_type: doc_type_ru,
        priority_weight,
        intent_tags
      })
      .select("*, manufacturers(name_ru)")
      .single();

    if (dbError) {
      await supabase.storage.from("documents").remove([fileName]);
      return NextResponse.json({ error: "Ошибка БД: " + dbError.message }, { status: 500 });
    }

    const extractionResult = await extractAndChunk(doc.id, buffer);
    const documentId = doc.id;
    const chunksCreated = extractionResult?.chunks_created ?? 0;
    console.log("=== UPLOAD END ===", { documentId, chunksCreated, fileName });

    return NextResponse.json({ document: doc }, { status: 201 });
  }

  const body = await request.json();
  const { data, error } = await supabase
    .from("documents")
    .insert(body)
    .select("*, manufacturers(name_ru)")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ document: data }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const supabase = createClient();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id обязателен" }, { status: 400 });

  const { data: doc } = await supabase.from("documents").select("file_url, file_name").eq("id", id).single();

  if (doc?.file_name) {
    await supabase.storage.from("documents").remove([doc.file_name]);
  }

  const { error } = await supabase.from("documents").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

async function extractAndChunk(documentId: string, buffer: Buffer) {
  try {
    const supabase = createClient();
    const pdfParse = (await import("pdf-parse")).default as any;
    const parsedPdf = await pdfParse(buffer);
    let extractedText = parsedPdf.text?.trim() || "";

    if (extractedText.length < 50) {
      console.log(`📸 Скан обнаружен, запускаем OCR: ${documentId}`);

      try {
        const { extractTextWithOCR } = await import("@/lib/ocr");
        const ocrText = await extractTextWithOCR(buffer);

        if (ocrText.length > 50) {
          console.log(`✅ OCR успешен, символов: ${ocrText.length}`);
          extractedText = ocrText;
        } else {
          throw new Error("OCR вернул пустой текст");
        }
      } catch (ocrErr) {
        console.error("❌ OCR ошибка:", ocrErr);
        const { data: existingDoc } = await supabase
          .from("documents")
          .select("notes")
          .eq("id", documentId)
          .single();
        const existingNotes = (existingDoc?.notes as string | null) ?? "";
        await supabase
          .from("documents")
          .update({
            extracted_text: "",
            notes: `${existingNotes}\n[СКАН: OCR не удался]`
          })
          .eq("id", documentId);
        return { success: true, warning: "OCR не удался", chunks_created: 0 };
      }
    }

    const chunks = splitTextIntoChunks(extractedText, 1000, 200);

    if (chunks.length > 0) {
      await supabase.from("document_chunks").insert(
        chunks.map((chunk, index) => ({
          document_id: documentId,
          content: chunk,
          chunk_index: index,
          metadata: { total_chunks: chunks.length, pages: parsedPdf.numpages }
        }))
      );
    }

    let detectedManufacturerId: string | null = null;
    const { data: existingDoc } = await supabase
      .from("documents")
      .select("manufacturer_id")
      .eq("id", documentId)
      .single();
    let manufacturer_id = (existingDoc?.manufacturer_id as string | null) ?? null;

    if (!manufacturer_id && chunks.length > 0) {
      const fullText = chunks.join(" ");
      detectedManufacturerId = await detectManufacturerFromContent(
        fullText,
        supabase as ReturnType<typeof getServiceSupabase>
      );
      if (detectedManufacturerId) {
        manufacturer_id = detectedManufacturerId;
        console.log("🔍 Производитель определён по содержимому PDF");
      }
    }

    const updatePayload: Record<string, unknown> = { extracted_text: extractedText.slice(0, 10000) };
    if (manufacturer_id) {
      updatePayload.manufacturer_id = manufacturer_id;
    }
    await supabase.from("documents").update(updatePayload).eq("id", documentId);

    console.log(`✅ PDF обработан: ${documentId}, страниц: ${parsedPdf.numpages}, чанков: ${chunks.length}`);
    return { success: true, chunks_created: chunks.length };
  } catch (e) {
    console.error(`❌ Ошибка обработки PDF ${documentId}:`, e);
    return { success: false, chunks_created: 0 };
  }
}

function splitTextIntoChunks(text: string, chunkSize = 1000, overlap = 200): string[] {
  const chunks: string[] = [];
  if (!text?.trim()) return chunks;
  const step = Math.max(1, chunkSize - overlap);
  for (let i = 0; i < text.length; i += step) {
    const chunk = text.slice(i, i + chunkSize).trim();
    if (chunk.length > 50) chunks.push(chunk);
  }
  return chunks;
}
