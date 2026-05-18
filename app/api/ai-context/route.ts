import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// ─── типы ────────────────────────────────────────────────────
interface ChunkRow {
  id: string
  content: string
  chunk_index: number
  document_id: string
  doc_type?: string
  priority_weight?: number
  intent_tags?: string[]
  metadata?: Record<string, unknown>
  documents?: {
    id: string
    title: string
    doc_type?: string
    manufacturers?: { name_ru: string } | { name_ru: string }[]
  }
  // поля из get_ai_context RPC
  chunk_id?: string
  chunk_content?: string
  doc_title?: string
  product_name?: string
  product_kod?: string
  manufacturer?: string
  rank?: number
}

function normalizeChunk(raw: Record<string, unknown>): ChunkRow {
  const docRaw = raw['documents']
  const doc = Array.isArray(docRaw) ? docRaw[0] : docRaw
  const mfrRaw = (doc as any)?.manufacturers
  const mfr = Array.isArray(mfrRaw) ? mfrRaw[0] : mfrRaw
  return {
    id:              String(raw['id'] ?? ''),
    content:         String(raw['content'] ?? ''),
    chunk_index:     Number(raw['chunk_index'] ?? 0),
    document_id:     String(raw['document_id'] ?? ''),
    doc_type:        raw['doc_type'] as string | undefined,
    priority_weight: raw['priority_weight'] as number | undefined,
    intent_tags:     raw['intent_tags'] as string[] | undefined,
    metadata:        raw['metadata'] as Record<string, unknown> | undefined,
    documents: doc
      ? {
          id:            String((doc as any).id ?? ''),
          title:         String((doc as any).title ?? ''),
          doc_type:      (doc as any).doc_type as string | undefined,
          manufacturers: mfr ?? undefined,
        }
      : undefined,
  }
}

// ─── route ───────────────────────────────────────────────────
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  // старые параметры (обратная совместимость)
  const rawQuery = searchParams.get('query') || searchParams.get('q') || ''

  // Очищаем вопрос — убираем стоп-слова и оставляем ключевые термины
  function extractKeywords(text: string): string {
    const stopWords = new Set([
      'какие', 'какой', 'какая', 'что', 'где', 'как', 'есть', 'на', 'для',
      'по', 'из', 'в', 'с', 'и', 'или', 'не', 'это', 'нам', 'нас', 'мне', 'продукцию',
      'продукции', 'подберите', 'найдите', 'покажите', 'скажите',
      'расскажите', 'расскажи', 'нужен', 'нужна', 'нужно',
      'про', 'об', 'при', 'все', 'был', 'есть', 'тот', 'эта',
    ]);

    // Убираем знаки препинания, приводим к нижнему регистру
    const words = text.toLowerCase()
      .replace(/[?!.,;:]/g, '')
      .split(/\s+/)
      .filter(w => w.length >= 2 && !stopWords.has(w));

    // Добавляем расширения для брендов (НЕ заменяем оригинал)
    const brandExpansions: Record<string, string> = {
      'церезит': 'ceresit',
      'ceresit': 'церезит',
      'плитонит': 'plitonit',
      'plitonit': 'плитонит',
      'plitosil': 'плитосил',
      'основит': 'osnovit',
      'xotpipe': 'хотпайп',
      'хотпайп': 'xotpipe',
      'экоролл': 'ekoroll',
      'ekoroll': 'экоролл',
      'rockwool': 'роквул',
      'роквул': 'rockwool',
      'cutwool': 'катвул',
      'катвул': 'cutwool',
      'isotec': 'изотек',
      'ст': 'ct',
      'ct': 'ст',
      'см': 'cm',
      'cm': 'см',
      'сх': 'cx',
      'cx': 'сх',
      'сл': 'cl',
      'cl': 'сл',
    };

    const extra: string[] = [];
    for (const word of words) {
      if (brandExpansions[word]) {
        extra.push(brandExpansions[word]);
      }
    }

    // Транслитерация для артикулов типа "СТ 83" → "CT 83"
    const result = [...words, ...extra];
    const translitMap: Record<string, string> = {
      'ст': 'ct', 'ct': 'ст',
      'см': 'cm', 'cm': 'см',
      'сх': 'cx', 'cx': 'сх',
      'сл': 'cl', 'cl': 'сл',
    };
    for (let i = 0; i < words.length - 1; i++) {
      const w = words[i];
      const next = words[i + 1];
      if (translitMap[w] && /^\d+/.test(next)) {
        // Нашли артикул типа "СТ 83" — добавляем "CT 83"
        result.push(translitMap[w], next);
      }
    }

    return result.join(' ');
  }

  const query = extractKeywords(rawQuery);
  const searchQuery = query.length >= 2 ? query : rawQuery;
  console.log('Original query:', rawQuery, '→ Keywords:', query);
  const limitChunks = Math.min(parseInt(searchParams.get('limit_chunks') || searchParams.get('limit') || '5'), 10)

  // Определяем производителя из запроса
  const queryLowerRaw = rawQuery.toLowerCase();
  const manufacturerMap: Record<string, string> = {
    'церезит': '80a19db2-d3ea-4b84-84b5-3369e7633a6e',
    'ceresit': '80a19db2-d3ea-4b84-84b5-3369e7633a6e',
    'плитонит': '092488a5-6935-422f-812c-089d8272a283',
    'plitonit': '092488a5-6935-422f-812c-089d8272a283',
    'plitosil': '092488a5-6935-422f-812c-089d8272a283',
    'основит': '059697ca-bb21-46ed-aa4b-ef2756a06f53',
    'индастро': 'd53cdc78-f96d-48e2-9060-e737bb3dd18e',
    'веккерле': 'c60125cf-749b-43e5-95b3-ceae150065e5',
    'xotpipe': '1b4a5543-7101-46cd-9a85-9866dd1132a9',
    'хотпайп': '1b4a5543-7101-46cd-9a85-9866dd1132a9',
    'экоролл': '4deb56f0-b7c9-46e9-8279-9fc4397419dd',
    'ekoroll': '4deb56f0-b7c9-46e9-8279-9fc4397419dd',
    'rockwool': '6f22e435-08cc-46ab-ba45-d119ce497581',
    'роквул': '6f22e435-08cc-46ab-ba45-d119ce497581',
    'вайред': '6f22e435-08cc-46ab-ba45-d119ce497581',
    'вайред мат': '6f22e435-08cc-46ab-ba45-d119ce497581',
    'rwl': '6f22e435-08cc-46ab-ba45-d119ce497581',
    'ламелла мат': '6f22e435-08cc-46ab-ba45-d119ce497581',
    'технониколь': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'technonicol': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'технофас': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'техновент': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'техноруф': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'технолайт': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'техноблок': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'техноакустик': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'технофлор': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'техносэндвич': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'carbon prof': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'carbon eco': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'carbon solid': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'xps технониколь': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'logicpir': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'logicroof': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'роклайт': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'изовол': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'izovol': 'f5fc0110-8057-47fd-9811-9aa1a2e81d8b',
    'икопал': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'icopal': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'виллафлекс': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'виллатекс': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'виллаэласт': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'вилладрейн': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'ультранап': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'монарплан': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'синтан': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'теранап': 'f7fac0e0-a00c-4ef0-a456-bc8b097c1204',
    'baswool': 'c0f1731c-12a2-4d6a-bca3-6020711de7f5',
    'басвул': 'c0f1731c-12a2-4d6a-bca3-6020711de7f5',
    'басвуль': 'c0f1731c-12a2-4d6a-bca3-6020711de7f5',
    'sika': '7fd8b297-1990-4366-836f-113985a0cd91',
    'зика': '7fd8b297-1990-4366-836f-113985a0cd91',
    'sikaplan': '7fd8b297-1990-4366-836f-113985a0cd91',
    'sikafloor': '7fd8b297-1990-4366-836f-113985a0cd91',
    'sikaemaco': '7fd8b297-1990-4366-836f-113985a0cd91',
    'пеноплэкс': '4584f447-4178-4757-901a-00f38614c381',
    'penoplex': '4584f447-4178-4757-901a-00f38614c381',
    'plastfoil': '4584f447-4178-4757-901a-00f38614c381',
    'hotrock': '4bdf5e83-5b51-4e91-8edf-5cef85bd5560',
    'хотрок': '4bdf5e83-5b51-4e91-8edf-5cef85bd5560',
    'k-flex': 'e60a463e-1471-4491-a323-4a13f375f044',
    'кфлекс': 'e60a463e-1471-4491-a323-4a13f375f044',
    'к-флекс': 'e60a463e-1471-4491-a323-4a13f375f044',
    'kflex': 'e60a463e-1471-4491-a323-4a13f375f044',
    'кнауф': 'dee03c0e-aa7f-4b28-a1a5-73dcf3dfd30c',
    'knauf': 'dee03c0e-aa7f-4b28-a1a5-73dcf3dfd30c',
    'кнауф инсулейшн': 'dee03c0e-aa7f-4b28-a1a5-73dcf3dfd30c',
    'теплокнауф': 'dee03c0e-aa7f-4b28-a1a5-73dcf3dfd30c',
    'кроз': 'f3299ec6-1174-44dc-8c14-457adf1bc7a9',
    'kroz': 'f3299ec6-1174-44dc-8c14-457adf1bc7a9',
    'огневент': 'f3299ec6-1174-44dc-8c14-457adf1bc7a9',
    'вбор': 'f3299ec6-1174-44dc-8c14-457adf1bc7a9',
    'pro-мбор': 'c2b8ab7c-79a8-40dd-882a-07e1f591de8d',
    'промбор': 'c2b8ab7c-79a8-40dd-882a-07e1f591de8d',
    'мбор': 'c2b8ab7c-79a8-40dd-882a-07e1f591de8d',
    'cutwool': '6bc4d830-ca68-4a3e-8dbf-570a220f14ea',
    'isotec': '96cd9ebc-b30c-4544-930e-1f375745fa48',
  };

  /** manufacturer_id → brand как в nomenclature_1c (подмножество manufacturerMap) */
  const brandNameMap: Record<string, string> = {
    '1b4a5543-7101-46cd-9a85-9866dd1132a9': 'XOTPIPE',
    '4deb56f0-b7c9-46e9-8279-9fc4397419dd': 'ЭКОРОЛЛ',
    'c0f1731c-12a2-4d6a-bca3-6020711de7f5': 'BASWOOL',
    '6f22e435-08cc-46ab-ba45-d119ce497581': 'ROCKWOOL',
    'f5fc0110-8057-47fd-9811-9aa1a2e81d8b': 'ТЕХНОНИКОЛЬ',
    'f7fac0e0-a00c-4ef0-a456-bc8b097c1204': 'ИКОПАЛ',
    'e60a463e-1471-4491-a323-4a13f375f044': 'K-FLEX',
    'dee03c0e-aa7f-4b28-a1a5-73dcf3dfd30c': 'КНАУФ',
    '4584f447-4178-4757-901a-00f38614c381': 'ПЕНОПЛЭКС',
    '4bdf5e83-5b51-4e91-8edf-5cef85bd5560': 'HOTROCK',
  }

  const nomenclatureBrandKeywordMap: Record<string, string> = {
    'xotpipe': 'XOTPIPE',
    'хотпайп': 'XOTPIPE',
    'экоролл': 'ЭКОРОЛЛ',
    'ekoroll': 'ЭКОРОЛЛ',
    'rockwool': 'ROCKWOOL',
    'роквул': 'ROCKWOOL',
    'baswool': 'BASWOOL',
    'басвул': 'BASWOOL',
    'технониколь': 'ТЕХНОНИКОЛЬ',
    'technonicol': 'ТЕХНОНИКОЛЬ',
    'икопал': 'ИКОПАЛ',
    'icopal': 'ИКОПАЛ',
    'k-flex': 'K-FLEX',
    'kflex': 'K-FLEX',
    'к-флекс': 'K-FLEX',
    'кфлекс': 'K-FLEX',
    'кнауф': 'КНАУФ',
    'knauf': 'КНАУФ',
    'пеноплэкс': 'ПЕНОПЛЭКС',
    'penoplex': 'ПЕНОПЛЭКС',
    'hotrock': 'HOTROCK',
    'хотрок': 'HOTROCK',
    'дорнит': 'ДОРНИТ',
    'армостаб': 'АРМОСТАБ',
  }

  // Приоритет брендов для подбора (когда нет конкретного бренда в запросе)
  // Порядок = приоритет предложения менеджеру
  const BRAND_PRIORITY = [
    'c0f1731c-12a2-4d6a-bca3-6020711de7f5', // BASWOOL - первый приоритет
    '6f22e435-08cc-46ab-ba45-d119ce497581', // ROCKWOOL
    'f5fc0110-8057-47fd-9811-9aa1a2e81d8b', // ТЕХНОНИКОЛЬ - только XPS и гидроизоляция
    'f7fac0e0-a00c-4ef0-a456-bc8b097c1204', // ИКОПАЛ
    '80a19db2-d3ea-4b84-84b5-3369e7633a6e', // ЦЕРЕЗИТ
  ]
  let detectedManufacturerId: string | null = null;
  for (const [kw, id] of Object.entries(manufacturerMap)) {
    if (queryLowerRaw.includes(kw)) {
      detectedManufacturerId = id;
      break;
    }
  }

  // новые параметры
  const product_id  = searchParams.get('product_id')  || null
  const category_id = searchParams.get('category_id') || null
  const intentRaw   = searchParams.get('intent')       // 'selection,manager'
  const docTypesRaw = searchParams.get('doc_types')    // 'script,tds'

  const intent_tags   = intentRaw   ? intentRaw.split(',').map(s => s.trim())   : null
  const doc_types_arr = docTypesRaw ? docTypesRaw.split(',').map(s => s.trim()) : null

  const supabase = createClient()
  const queryKeywords = query
  const STOP_WORDS = ['технониколь', 'technonicol', 'rockwool', 'роквул', 'baswool', 'басвул', 'штукатурный', 'навесной', 'утеплитель'];
  const meaningfulKeywords = queryKeywords
    .split(' ')
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length > 3 && !STOP_WORDS.includes(w))

  const extractExplicitSizeNumbers = (text: string) => {
    const matches = Array.from(text.matchAll(/(\d{2,4})\s*[xх*]\s*(\d{1,4})(?:\s*[xх*]\s*(\d{1,4}))?/gi))
    let best: { numbers: string[]; score: number } | null = null

    for (const match of matches) {
      const [raw, firstRaw, secondRaw, thirdRaw] = match
      const index = match.index ?? 0
      const before = text.slice(Math.max(0, index - 60), index).toLowerCase()
      const after = text.slice(index + raw.length, index + raw.length + 60).toLowerCase()
      const context = `${before} ${after}`
      const first = Number(firstRaw)
      const second = Number(secondRaw)
      const third = thirdRaw ? Number(thirdRaw) : null

      if (/o-me|ome|окож|кожух|zn|оцинк|нержав|алюмин/i.test(context)) continue

      let numbers: string[] | null = null
      if (third !== null && first >= 900 && second <= 1220 && third <= 300) {
        numbers = [secondRaw, thirdRaw]
      } else if (third !== null && third >= 900 && first <= 1220 && second <= 300) {
        numbers = [firstRaw, secondRaw]
      } else if (third === null && first <= 1220 && second <= 300) {
        numbers = [firstRaw, secondRaw]
      }
      if (!numbers) continue

      let score = 1
      if (/цилиндр|скорлуп|отвод|xotpipe|хотпайп|sp[-\s]*\d+|dt/i.test(context)) score += 5
      if (third !== null) score += 2
      if (numbers[1] === '30' || numbers[1] === '50' || numbers[1] === '70') score += 1

      if (!best || score > best.score) {
        best = { numbers, score }
      }
    }

    return best?.numbers ?? null
  }

  // Extract numbers from rawQuery for product filtering
  const queryNumbers = (rawQuery.match(/\d+/g) || []).filter((n) => n.length >= 2)
  const requestedSizeNumbers = extractExplicitSizeNumbers(rawQuery) ?? queryNumbers
  const allKeywords = [...meaningfulKeywords, ...requestedSizeNumbers]

  const hasExactSizeInText = (text: string, firstSize: string, secondSize: string) => {
    const pattern = new RegExp(`(^|\\D)${firstSize}\\s*[xх*\\-]\\s*${secondSize}(\\D|$)`, 'i')
    return pattern.test(text)
  }

  const productMatchesRequestedSize = (product: any, firstSize: string, secondSize: string) => {
    return hasExactSizeInText(product.name || '', firstSize, secondSize)
  }

  const filterProductsByRequestedSize = (items: any[]) => {
    if (requestedSizeNumbers.length < 2) return items
    const [firstSize, secondSize] = requestedSizeNumbers
    return items.filter((item) => productMatchesRequestedSize(item, firstSize, secondSize))
  }

  // Продукты: сначала производитель + ключевые слова, потом fallback на производителя
  let products: any[] = []
  if (product_id) {
    const { data } = await supabase
      .from('products')
      .select(`
        id, kod_1c, name, coating, flammability,
        temp_max, temp_min, diameter_min, diameter_max,
        density, thickness, in_stock,
        manufacturer_id, manufacturers(name_ru),
        category_id, categories(name, full_path)
      `)
      .eq('id', product_id)
      .eq('in_stock', true)
      .limit(30)
    products = filterProductsByRequestedSize(data ?? [])
  } else if (detectedManufacturerId) {
    let keywordQuery = supabase
      .from('products')
      .select(`
        id, kod_1c, name, coating, flammability,
        temp_max, temp_min, diameter_min, diameter_max,
        density, thickness, in_stock,
        manufacturer_id, manufacturers(name_ru),
        category_id, categories(name, full_path)
      `)
      .eq('manufacturer_id', detectedManufacturerId)
      .eq('in_stock', true)
      .limit(30)

    if (allKeywords.length > 0) {
      keywordQuery = keywordQuery.or(
        allKeywords.map((k) => `name.ilike.%${k}%`).join(',')
      )
    }

    const { data: keywordProducts } = await keywordQuery
    products = filterProductsByRequestedSize(keywordProducts ?? [])

    // Fallback только для запросов без конкретного размера, иначе он создаёт ложные рекомендации.
    if (products.length < 5 && requestedSizeNumbers.length < 2) {
      const { data: fallbackProducts } = await supabase
        .from('products')
        .select(`
          id, kod_1c, name, coating, flammability,
          temp_max, temp_min, diameter_min, diameter_max,
          density, thickness, in_stock,
          manufacturer_id, manufacturers(name_ru),
          category_id, categories(name, full_path)
        `)
        .eq('manufacturer_id', detectedManufacturerId)
        .eq('in_stock', true)
        .limit(30)
      products = fallbackProducts ?? []
    }
  } else {
    let genericQuery = supabase
      .from('products')
      .select(`
        id, kod_1c, name, coating, flammability,
        temp_max, temp_min, diameter_min, diameter_max,
        density, thickness, in_stock,
        manufacturer_id, manufacturers(name_ru),
        category_id, categories(name, full_path)
      `)
      .eq('in_stock', true)
      .limit(30)

    if (allKeywords.length > 0) {
      genericQuery = genericQuery.or(
        allKeywords.map((k) => `name.ilike.%${k}%`).join(',')
      )
    }

    const { data } = await genericQuery
    products = filterProductsByRequestedSize(data ?? [])
  }

  type NomenclatureItem = {
    id: string
    code: string | null
    article: string | null
    name: string | null
    brand: string | null
  }

  let relevant_nomenclature: NomenclatureItem[] = []
  let nomenclature_analogs: NomenclatureItem[] = []
  let nomenclature_accessories: NomenclatureItem[] = []
  let requested_invoice_items: NomenclatureItem[] = []

  const getNomenclatureItemType = (name?: string | null) => {
    const lower = (name || '').toLowerCase()
    if (/цилиндр|скорлуп/i.test(lower)) return 'cylinder'
    if (/заглуш|пробк/i.test(lower)) return 'end_cap'
    if (/отвод|колено/i.test(lower)) return 'elbow'
    if (/тройник/i.test(lower)) return 'tee'
    if (/переход/i.test(lower)) return 'transition'
    if (/сегмент/i.test(lower)) return 'segment'
    return 'other'
  }

  const hasStandaloneNumber = (text: string, value: string) => {
    const pattern = new RegExp(`(^|\\D)${value}(\\D|$)`, 'i')
    return pattern.test(text)
  }

  const isGeotextileNomenclature = (name?: string | null) =>
    /геотекст|геоткан|дорнит|геоком|georex|полотно иглопробивное/i.test(name || '') &&
    !/геореш[её]тк|геомембран/i.test(name || '')

  const hasGeotextileDensity = (name: string | null | undefined, density: string) => {
    const text = name || ''
    if (new RegExp(`(^|\\D)${density}\\s*(?:м2|м²|m2)(\\D|$)`, 'i').test(text)) return false

    const densityUnitPattern = new RegExp(`(^|\\D)${density}\\s*(?:г|гр|g)\\s*\\/?\\s*(?:м2|м²|кв\\.?\\s*м|m2)(\\D|$)`, 'i')
    const productDensityPattern = new RegExp(`(?:геотекст|геоткан|дорнит|геоком|georex|пэ|пэт|пфг|a-)\\D{0,24}${density}(\\D|$)`, 'i')
    return densityUnitPattern.test(text) || productDensityPattern.test(text)
  }

  const isXpsNomenclature = (name?: string | null) =>
    /xps|экструзия|экструзионн|пенопл[еэ]кс|техноплекс|carbon|ursa n|калкан/i.test(name || '') &&
    !/геомембран|мембран|геотекст|геореш[её]тк|цилиндр|rockwool|роквул/i.test(name || '')

  const hasBoardThickness = (name: string | null | undefined, thickness: string) => {
    const text = name || ''
    const patterns = [
      new RegExp(`\\d{3,4}\\s*[xх*]\\s*${thickness}\\s*(мм|\\)|\\s|,|$)`, 'i'),
      new RegExp(`(^|\\D)${thickness}\\s*(мм|$)`, 'i'),
      new RegExp(`(^|\\D)${thickness}\\s*[xх*]\\s*\\d{3,4}\\s*[xх*]\\s*\\d{3,4}(\\D|$)`, 'i'),
      new RegExp(`(^|\\D)\\d+\\s*\\/\\s*${thickness}\\s*[xх*]\\s*\\d{3,4}`, 'i'),
    ]
    return patterns.some((pattern) => pattern.test(text))
  }

  const dedupeNomenclature = (items: NomenclatureItem[]) => {
    const seen = new Set<string>()
    const result: NomenclatureItem[] = []
    for (const item of items) {
      const normalizedName = (item.name || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const key = normalizedName
        ? `text:${normalizedName}|${item.brand || ''}`
        : `code:${item.code || ''}|${item.article || ''}`
      if (seen.has(key)) continue
      seen.add(key)
      result.push(item)
    }
    return result
  }

  const isNomenclatureAccessory = (name?: string | null) =>
    ['end_cap', 'elbow', 'tee', 'transition', 'segment'].includes(getNomenclatureItemType(name))

  const addRequestedInvoiceArticles = (articles: Set<string>) => {
    const [firstSize, secondSize] = requestedSizeNumbers
    const hasXotpipeSp100 = /xotpipe|хотпайп/i.test(rawQuery) && /\bsp[-\s]*100\b/i.test(rawQuery)

    if (hasXotpipeSp100 && firstSize && secondSize) {
      if (/цилиндр/i.test(rawQuery) && /без покрыт/i.test(rawQuery)) {
        articles.add(`SP100L10DT${firstSize}-${secondSize}`)
      }
      if (/l[-\s]*90|отвод\s*90/i.test(rawQuery) && /без покрыт/i.test(rawQuery)) {
        articles.add(`SP100L90DT${firstSize}-${secondSize}`)
      }
    }

    for (const match of rawQuery.matchAll(/O-ME-ZN\s+(\d{2,4})\s*[xх*]\s*(\d{3,4})/gi)) {
      const diameter = match[1]
      const length = match[2]
      articles.add(`OMEZNLD${length}-${diameter}`)
    }

    for (const match of rawQuery.matchAll(/O-ME-ZN\s+L-1-90\s+(\d{2,4})/gi)) {
      articles.add(`OMEZNL190D${match[1]}`)
    }
  }

  const getSizeFilters = (firstSize: string, secondSize: string) => [
    `name.ilike.% ${firstSize}x${secondSize}%`,
    `name.ilike.% ${firstSize}х${secondSize}%`,
    `name.ilike.% ${firstSize}-${secondSize}%`,
    `name.ilike.%(${firstSize}x${secondSize}%`,
    `name.ilike.%(${firstSize}х${secondSize}%`,
    `name.ilike.%(${firstSize}-${secondSize}%`,
    `article.ilike.%${firstSize}-${secondSize}%`,
    `article.ilike.%${firstSize}x${secondSize}%`,
    `article.ilike.%${firstSize}х${secondSize}%`,
  ]

  const hasExactSize = (item: NomenclatureItem, firstSize: string, secondSize: string) => {
    const text = `${item.article || ''} ${item.name || ''}`
    return hasExactSizeInText(text, firstSize, secondSize)
  }

  if (queryNumbers.length > 0) {
    let nomQuery = supabase
      .from('nomenclature_1c')
      .select('id, code, article, name, brand')
      .limit(20)

    const nomBrandFromKeyword = Object.entries(nomenclatureBrandKeywordMap)
      .find(([kw]) => queryLowerRaw.includes(kw))?.[1]

    const nomBrand =
      detectedManufacturerId && brandNameMap[detectedManufacturerId]
        ? brandNameMap[detectedManufacturerId]
        : nomBrandFromKeyword
    if (nomBrand) {
      nomQuery = nomQuery.eq('brand', nomBrand)
    }

    if (requestedSizeNumbers.length >= 2) {
      const [firstSize, secondSize] = requestedSizeNumbers
      const sizeFilters = getSizeFilters(firstSize, secondSize).join(',')

      nomQuery = nomQuery.or(sizeFilters)
    } else {
      const nomFilters = queryNumbers.flatMap((k) => [
        `name.ilike.% ${k} %`,
        `name.ilike.% ${k}мм%`,
        `name.ilike.% ${k} мм%`,
        `name.ilike.%x${k} %`,
        `name.ilike.%x${k} (%`,
        `name.ilike.%x${k})%`,
        `name.ilike.%x${k},%`,
        `name.ilike.%x${k}мм%`,
        `name.ilike.%х${k} %`,
        `name.ilike.%х${k} (%`,
        `name.ilike.%х${k})%`,
        `name.ilike.%х${k},%`,
        `name.ilike.%х${k}мм%`,
        `name.ilike.%-${k} %`,
        `name.ilike.%-${k})%`,
        `article.ilike.%${k}%`,
      ]).join(',')
      if (nomFilters) {
        nomQuery = nomQuery.or(nomFilters)
      }
    }

    if (/геотекст|геоткан|дорнит/i.test(rawQuery)) {
      nomQuery = nomQuery.ilike('name', '%геотекст%')
    }

    const isAccessoryQuery = /отвод|заглуш|пробк|тройник|переход|сегмент|колено/i.test(rawQuery)
    const isImplicitXotpipeCylinderQuery =
      /xotpipe|хотпайп/i.test(rawQuery) &&
      /\bsp\b/i.test(rawQuery) &&
      requestedSizeNumbers.length >= 2 &&
      !isAccessoryQuery
    const isCylinderQuery = /цилиндр|цилиндры|скорлуп/i.test(rawQuery) || isImplicitXotpipeCylinderQuery
    if (isCylinderQuery) {
      nomQuery = nomQuery.ilike('name', '%цилиндр%')
    }

    const { data: nomData } = await nomQuery
    relevant_nomenclature = dedupeNomenclature(nomData ?? [])

    const hasGeotextileInQuery = /геотекст|дорнит|геоткан/i.test(rawQuery)
    const hasXpsInQuery = /xps|экструз|пенопл[еэ]кс|penoplex|техноплекс|carbon/i.test(rawQuery)

    if (queryNumbers.length === 1 && (hasGeotextileInQuery || hasXpsInQuery)) {
      const [singleValue] = queryNumbers
      const specialQueries = []

      if (hasGeotextileInQuery) {
        specialQueries.push(
          supabase
            .from('nomenclature_1c')
            .select('id, code, article, name, brand')
            .ilike('name', `%${singleValue}%`)
            .or('name.ilike.%геотекст%,name.ilike.%геоткан%,name.ilike.%дорнит%,name.ilike.%геоком%,name.ilike.%georex%')
            .limit(1000)
        )
        if (nomBrand) {
          specialQueries.push(
            supabase
              .from('nomenclature_1c')
              .select('id, code, article, name, brand')
              .eq('brand', nomBrand)
              .ilike('name', `%${singleValue}%`)
              .limit(500)
          )
        }
      }

      if (hasXpsInQuery) {
        specialQueries.push(
          supabase
            .from('nomenclature_1c')
            .select('id, code, article, name, brand')
            .ilike('name', `%${singleValue}%`)
            .or('name.ilike.%xps%,name.ilike.%экструзи%,name.ilike.%экструдир%,name.ilike.%пенопл%,name.ilike.%техноплекс%,name.ilike.%carbon%')
            .limit(1000)
        )
        if (nomBrand) {
          specialQueries.push(
            supabase
              .from('nomenclature_1c')
              .select('id, code, article, name, brand')
              .eq('brand', nomBrand)
              .ilike('name', `%${singleValue}%`)
              .limit(500)
          )
        }
      }

      const specialResults = await Promise.all(specialQueries)
      const broadNomenclatureById = new Map<string, NomenclatureItem>()
      for (const result of specialResults) {
        for (const item of ((result.data ?? []) as NomenclatureItem[])) {
          broadNomenclatureById.set(item.id, item)
        }
      }

      const broadNomenclature = Array.from(broadNomenclatureById.values())
      const matchesSpecialQuery = (item: NomenclatureItem) => {
        if (hasGeotextileInQuery) {
          const brandOrName = `${item.brand || ''} ${item.name || ''}`.toLowerCase()
          const matchesRequestedBrand =
            !nomBrand ||
            item.brand === nomBrand ||
            (nomBrand === 'ДОРНИТ' && !item.brand && /дорнит/.test(brandOrName))
          return matchesRequestedBrand && isGeotextileNomenclature(item.name) && hasGeotextileDensity(item.name, singleValue)
        }
        if (hasXpsInQuery) {
          const brandOrName = `${item.brand || ''} ${item.name || ''}`.toLowerCase()
          const matchesRequestedBrand =
            !nomBrand ||
            item.brand === nomBrand ||
            (nomBrand === 'ПЕНОПЛЭКС' && !item.brand && /пенопл[еэ]кс/.test(brandOrName))
          return matchesRequestedBrand && isXpsNomenclature(item.name) && hasBoardThickness(item.name, singleValue)
        }
        return false
      }

      relevant_nomenclature = broadNomenclature
        .filter(matchesSpecialQuery)
        .filter((item) => item.code !== 'ЦБ50593')
      relevant_nomenclature = dedupeNomenclature(relevant_nomenclature)
        .slice(0, 20)

      const relevantSpecialIds = new Set(relevant_nomenclature.map((item) => item.id))
      nomenclature_analogs = broadNomenclature
        .filter((item) => !relevantSpecialIds.has(item.id))
        .filter((item) => {
          if (hasGeotextileInQuery) {
            const brandOrName = `${item.brand || ''} ${item.name || ''}`.toLowerCase()
            const isRequestedBrand =
              nomBrand &&
              (item.brand === nomBrand || (nomBrand === 'ДОРНИТ' && /дорнит/.test(brandOrName)))
            return !isRequestedBrand && isGeotextileNomenclature(item.name) && hasGeotextileDensity(item.name, singleValue)
          }
          if (hasXpsInQuery) {
            const brandOrName = `${item.brand || ''} ${item.name || ''}`.toLowerCase()
            const isRequestedBrand =
              nomBrand &&
              (item.brand === nomBrand || (nomBrand === 'ПЕНОПЛЭКС' && /пенопл[еэ]кс/.test(brandOrName)))
            return !isRequestedBrand && isXpsNomenclature(item.name) && hasBoardThickness(item.name, singleValue)
          }
          return false
        })
        .filter((item) => !nomBrand || item.brand !== nomBrand)
      nomenclature_analogs = dedupeNomenclature(nomenclature_analogs)
        .slice(0, 20)
    }

    if (requestedSizeNumbers.length >= 2) {
      const [firstSize, secondSize] = requestedSizeNumbers
      const [relatedByNameRes, relatedByArticleRes] = await Promise.all([
        supabase
          .from('nomenclature_1c')
          .select('id, code, article, name, brand')
          .ilike('name', `%${firstSize}%`)
          .ilike('name', `%${secondSize}%`)
          .limit(600),
        supabase
          .from('nomenclature_1c')
          .select('id, code, article, name, brand')
          .ilike('article', `%${firstSize}%`)
          .ilike('article', `%${secondSize}%`)
          .limit(600),
      ])

      const relatedById = new Map<string, NomenclatureItem>()
      for (const item of ([...(relatedByNameRes.data ?? []), ...(relatedByArticleRes.data ?? [])] as NomenclatureItem[])) {
        if (hasExactSize(item, firstSize, secondSize)) {
          relatedById.set(item.id, item)
        }
      }
      const relatedNomenclature = Array.from(relatedById.values())
      let accessoryCandidateNomenclature = relatedNomenclature
      if (nomBrand) {
        const [accessoryByNameRes, accessoryByArticleRes] = await Promise.all([
          supabase
            .from('nomenclature_1c')
            .select('id, code, article, name, brand')
            .eq('brand', nomBrand)
            .ilike('name', `%${firstSize}%`)
            .ilike('name', `%${secondSize}%`)
            .limit(800),
          supabase
            .from('nomenclature_1c')
            .select('id, code, article, name, brand')
            .eq('brand', nomBrand)
            .ilike('article', `%${firstSize}%`)
            .ilike('article', `%${secondSize}%`)
            .limit(800),
        ])
        const accessoryById = new Map<string, NomenclatureItem>()
        for (const item of ([...(accessoryByNameRes.data ?? []), ...(accessoryByArticleRes.data ?? [])] as NomenclatureItem[])) {
          if (hasExactSize(item, firstSize, secondSize)) {
            accessoryById.set(item.id, item)
          }
        }
        accessoryCandidateNomenclature = Array.from(accessoryById.values())
      }
      let analogCandidateNomenclature = relatedNomenclature
      if (nomBrand) {
        const [analogByNameRes, analogByArticleRes] = await Promise.all([
          supabase
            .from('nomenclature_1c')
            .select('id, code, article, name, brand')
            .neq('brand', nomBrand)
            .ilike('name', `%${firstSize}%`)
            .ilike('name', `%${secondSize}%`)
            .limit(200),
          supabase
            .from('nomenclature_1c')
            .select('id, code, article, name, brand')
            .neq('brand', nomBrand)
            .ilike('article', `%${firstSize}%`)
            .ilike('article', `%${secondSize}%`)
            .limit(200),
        ])
        const analogById = new Map<string, NomenclatureItem>()
        for (const item of ([...(analogByNameRes.data ?? []), ...(analogByArticleRes.data ?? [])] as NomenclatureItem[])) {
          if (hasExactSize(item, firstSize, secondSize)) {
            analogById.set(item.id, item)
          }
        }
        analogCandidateNomenclature = Array.from(analogById.values())
      }
      const relevantIds = new Set(relevant_nomenclature.map((item) => item.id))

      nomenclature_accessories = dedupeNomenclature(accessoryCandidateNomenclature
        .filter((item) => !relevantIds.has(item.id))
        .filter((item) => isNomenclatureAccessory(item.name)))
        .slice(0, 20)

      const needsCylinderAnalogs =
        relevant_nomenclature.some((item) => getNomenclatureItemType(item.name) === 'cylinder') ||
        /цилиндр|цилиндры|скорлуп|xotpipe|хотпайп/i.test(rawQuery)

      if (needsCylinderAnalogs) {
        nomenclature_analogs = dedupeNomenclature(analogCandidateNomenclature
          .filter((item) => !relevantIds.has(item.id))
          .filter((item) => getNomenclatureItemType(item.name) === 'cylinder'))
          .slice(0, 20)
      }
    }

    const requestedInvoiceArticles = new Set<string>()
    addRequestedInvoiceArticles(requestedInvoiceArticles)
    if (requestedInvoiceArticles.size > 0) {
      const invoiceMatches = await Promise.all(
        Array.from(requestedInvoiceArticles).map((article) =>
          supabase
            .from('nomenclature_1c')
            .select('id, code, article, name, brand')
            .eq('article', article)
            .limit(1)
        )
      )
      requested_invoice_items = dedupeNomenclature(
        invoiceMatches.flatMap((result) => (result.data ?? []) as NomenclatureItem[])
      )
    }
  }

  // Если очищенная 1С-номенклатура уже дала точные позиции, старый products не добавляем в контекст.
  if (relevant_nomenclature.length > 0 && queryNumbers.length > 0) {
    products = []
  }

  // ─── параллельные запросы ─────────────────────────────────
  const [rulesRes, notesRes, chunksRes] = await Promise.allSettled([

    // правила подбора (таблица осталась прежней)
    supabase
      .from('selection_rules')
      .select('id, title, condition, recommendation, priority')
      .limit(10),

    // заметки (таблица осталась прежней)
    supabase
      .from('knowledge_notes')
      .select('id, title, content, category')
      .limit(8),

    // чанки — пробуем новую RPC сначала, fallback на старую логику
    searchChunks(supabase, {
      query: searchQuery,
      limitChunks,
      product_id,
      manufacturer_id: detectedManufacturerId,
      category_id,
      intent_tags,
      doc_types_arr,
    }),
  ])

  const rules     = rulesRes.status    === 'fulfilled' ? (rulesRes.value.data    ?? []) : []
  const notes     = notesRes.status    === 'fulfilled' ? (notesRes.value.data    ?? []) : []
  const rawChunks = chunksRes.status   === 'fulfilled' ? chunksRes.value          : []

  const hasGeotextileQueryForContext = /геотекст|дорнит|геоткан/i.test(rawQuery)
  const hasXpsQueryForContext = /xps|экструз|пенопл[еэ]кс|penoplex|техноплекс|carbon/i.test(rawQuery)
  const hasCylinderQueryForContext = /цилиндр|скорлуп|xotpipe|хотпайп/i.test(rawQuery)
  const chunkMatchesQueryTheme = (chunk: ChunkRow) => {
    const doc = chunk.documents
    const mfrRaw = doc?.manufacturers
    const mfr = (Array.isArray(mfrRaw) ? mfrRaw[0] : mfrRaw)?.name_ru ?? chunk.manufacturer ?? ''
    const contentAndTitle = `${chunk.content || ''} ${doc?.title || chunk.doc_title || ''}`.toLowerCase()
    const text = `${contentAndTitle} ${mfr}`.toLowerCase()

    if (hasGeotextileQueryForContext) return /геотекст|геоткан|дорнит|геоком|georex|геосинтет/i.test(text)
    if (hasXpsQueryForContext) return /xps|экструз|пенополистирол|техноплекс|carbon|плиты?\s+пенопл[еэ]кс|пенопл[еэ]кс\s+(кровля|уклон|комфорт|гео|основа)/i.test(contentAndTitle)
    if (hasCylinderQueryForContext) return /цилиндр|скорлуп|xotpipe|хотпайп|трубопровод/i.test(text)
    return true
  }

  const chunks = deduplicateChunks(rawChunks.filter(chunkMatchesQueryTheme), limitChunks)
  const { data: rulesData } = await supabase
    .from('selection_rules')
    .select('id, rule_name, condition, rule_text, priority, is_prohibition, category')
    .order('priority', { ascending: true });

  const allRules = rulesData ?? [];

  // Фильтруем правила релевантные запросу
  const queryLower = query.toLowerCase();
  const relevantRules = allRules.filter(rule => {
    const conditions = rule.condition.toLowerCase().split(/[,+\s]+/);
    return conditions.some((cond: string) =>
      cond.length > 2 && queryLower.includes(cond)
    );
  });

  const topicProhibitionMatches = (rule: any) => {
    const haystack = `${rule.category || ''} ${rule.condition || ''} ${rule.rule_name || ''} ${rule.rule_text || ''}`.toLowerCase()
    if (hasGeotextileQueryForContext) return /геотекст|геоткан|дорнит|геосинтет|геореш|откос|склон|асфальт|площадк|парковк|нагруз/i.test(haystack)
    if (hasXpsQueryForContext) return /xps|пенополистирол|экструз|техноплекс|carbon/i.test(haystack)
    if (hasCylinderQueryForContext) return /цилиндр|труб|фольг|оцинк|котельн|шахт|xotpipe|хотпайп/i.test(haystack)
    return false
  }

  // Если релевантных нет — берём только тематические запреты, а не всю базу правил.
  const applicable_rules = relevantRules.length > 0
    ? relevantRules
    : allRules.filter(r => r.is_prohibition && topicProhibitionMatches(r));

  const selection_guidance = {
    clarification_needed: false,
    questions: [] as string[],
    answer_policy: [
      'Структура ответа менеджеру: 1) что найдено для счета по точным кодам 1С; 2) что является кандидатами в аналоги; 3) что нужно уточнить; 4) какие правила/техлисты ограничивают рекомендацию.',
      'Если в ответе есть requested_invoice_items, считать этот блок приоритетным для готового счета: это точные строки запроса, найденные по артикулам/кодам 1С.',
      'Для счета использовать только позиции из relevant_nomenclature с кодом 1С. Не писать "нет в базе", пока не проверены relevant_nomenclature, nomenclature_accessories и точные размерные совпадения.',
      'Не писать "в наличии", если в контексте нет подтвержденного остатка/склада. Разрешено писать только "есть в номенклатуре 1С" или "найден код 1С".',
      'Если пользователь просит счет, сначала собрать основной вариант по точным кодам 1С, а аналоги вынести отдельным блоком "кандидаты для альтернативного счета".',
    ],
    analog_policy: [
      'nomenclature_analogs — это кандидаты по типу товара и размеру/плотности/толщине, а не автоматическая равноценная замена.',
      'Перед рекомендацией аналога сверить условия применения: назначение, место монтажа, температура, пожарные требования, покрытие, плотность/марка и необходимость защитного слоя.',
      'Если у аналога другая плотность, покрытие, серия или нет подтверждения НГ/Г1 в правилах или техлисте, писать "кандидат в аналог, требует проверки по условиям".',
      'Не предлагать фольгированный аналог вместо решения "без покрытия + оцинкованная окожушка" без отдельного подтверждения, потому что фольга и оцинковка запрещены правилами.',
    ],
    evidence_policy: [
      'Не придумывать технические характеристики. Использовать только selection_rules и document_chunks из официальных техлистов/документов производителя.',
      'Если в контексте нет правила или официального техлиста под ситуацию клиента, нужно написать: требуется уточнение/проверка по техлисту производителя.',
      'Размер номенклатуры является фильтром, но не достаточным основанием для рекомендации аналога или аксессуара.',
      'Аксессуары предлагать только после понимания решения: где применяется материал, для чего, какие условия эксплуатации и какой тип покрытия/системы нужен.',
    ],
    recommendation_status: 'candidate_context_only',
  }

  const hasUseCaseInQuery = /улиц|помещ|труб|отопл|хвс|гвс|вент|котельн|наруж|внутр|оцинк|фольг|нг|дренаж|дорог|откос|склон|асфальт|фундамент|кровл|фасад/i.test(rawQuery)
  const hasCylinderInResult = relevant_nomenclature.some((item) => getNomenclatureItemType(item.name) === 'cylinder')
  const hasGeotextileInQuery = /геотекст|дорнит|геоткан/i.test(rawQuery)

  if (queryNumbers.length === 0) {
    selection_guidance.clarification_needed = true
    selection_guidance.questions.push('Уточните размер/плотность/толщину материала, без этого можно показать только общий раздел номенклатуры.')
  }

  if (relevant_nomenclature.length > 1) {
    selection_guidance.clarification_needed = true
    selection_guidance.questions.push('Найдено несколько позиций одного размера. Уточните точный вариант, который нужен клиенту.')
  }

  if (hasCylinderInResult) {
    if (!/alu|alu1|фольг|оцинк|me|outside|без покрыт|нг/i.test(rawQuery)) {
      selection_guidance.clarification_needed = true
      selection_guidance.questions.push('Для цилиндров уточните покрытие: без покрытия, Alu, Alu1/НГ, ME/оцинковка или Outside.')
    }
    if (!hasUseCaseInQuery) {
      selection_guidance.clarification_needed = true
      selection_guidance.questions.push('Для цилиндров уточните условия применения: внутри/улица, температура, нужна ли НГ-фольга, оцинковка или защитное покрытие.')
    }
  }

  if (nomenclature_analogs.length > 0) {
    selection_guidance.clarification_needed = true
    selection_guidance.questions.push('Аналоги найдены как кандидаты по размеру/типу. Перед включением в альтернативный счет уточните условия применения и требования к покрытию, плотности/марке и пожарной группе.')
  }

  if (hasGeotextileInQuery && relevant_nomenclature.length > 1) {
    selection_guidance.clarification_needed = true
    selection_guidance.questions.push('Для геотекстиля уточните плотность, ширину/длину рулона и задачу: дренаж, разделение слоёв, дорога, откос или другое применение.')
  }

  if (nomenclature_accessories.length > 0 && !hasUseCaseInQuery) {
    selection_guidance.clarification_needed = true
    selection_guidance.questions.push('Сопутствующие товары пока являются кандидатами по размеру. Чтобы рекомендовать их клиенту, уточните решение и место применения.')
  }

  let formattedContext = buildContext(
    query,
    products,
    rules,
    notes,
    chunks,
    relevant_nomenclature,
    nomenclature_analogs,
    nomenclature_accessories,
    requested_invoice_items
  )
  if (selection_guidance.questions.length > 0) {
    formattedContext += '\n\n## Что нужно уточнить у менеджера\n'
    formattedContext += selection_guidance.questions.map(q => `- ${q}`).join('\n')
  }
  formattedContext += '\n\n## Как отвечать менеджеру\n'
  formattedContext += selection_guidance.answer_policy.map(q => `- ${q}`).join('\n')
  formattedContext += '\n\n## Политика аналогов\n'
  formattedContext += selection_guidance.analog_policy.map(q => `- ${q}`).join('\n')
  formattedContext += '\n\n## Политика достоверности\n'
  formattedContext += selection_guidance.evidence_policy.map(q => `- ${q}`).join('\n')

  if (applicable_rules.length > 0) {
    const rulesText = applicable_rules
      .map(r => `${r.is_prohibition ? '🚫 ЗАПРЕТ' : '📋 ПРАВИЛО'}: ${r.rule_name}\n${r.rule_text}`)
      .join('\n\n');
    formattedContext += '\n\n## Правила подбора\n' + rulesText;
  }

  return NextResponse.json({
    query: rawQuery,
    query_keywords: query,
    filters: { product_id, category_id, intent_tags, doc_types: doc_types_arr },
    detected: {
      ...detectContext(query),
      requested_size:
        requestedSizeNumbers.length >= 2
          ? { diameter_mm: Number(requestedSizeNumbers[0]), thickness_mm: Number(requestedSizeNumbers[1]) }
          : null,
    },
    relevant_products: products,
    relevant_nomenclature,
    nomenclature_analogs,
    nomenclature_accessories,
    requested_invoice_items,
    selection_guidance,
    applicable_rules,
    relevant_notes: notes,
    document_chunks: chunks,
    formatted_context: formattedContext,
    meta: {
      products_count: products.length,
      nomenclature_count: relevant_nomenclature.length,
      nomenclature_analogs_count: nomenclature_analogs.length,
      nomenclature_accessories_count: nomenclature_accessories.length,
      requested_invoice_items_count: requested_invoice_items.length,
      clarification_needed: selection_guidance.clarification_needed,
      rules_count:    applicable_rules.length,
      notes_count:    notes.length,
      chunks_count:   chunks.length,
      brand_priority: BRAND_PRIORITY,
      requested_size_numbers: requestedSizeNumbers,
    },
  })
}

// ─── поиск чанков: title → RPC → старая RPC → FTS → ILIKE ─────
async function searchChunks(
  supabase: ReturnType<typeof createClient>,
  opts: {
    query:        string
    limitChunks:  number
    product_id:   string | null
    manufacturer_id: string | null
    category_id:  string | null
    intent_tags:  string[] | null
    doc_types_arr: string[] | null
  }
): Promise<ChunkRow[]> {
  const { query, limitChunks, product_id, manufacturer_id, category_id, intent_tags, doc_types_arr } = opts
  console.log('🔍 searchChunks called with query:', JSON.stringify(query));

  // ШАГ 0: Прямой поиск по названию документа (высший приоритет)
  // Ищем точное совпадение артикула в названии документа
  const rawWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2);

  // Строим фразы для поиска по title
  const titleSearchPhrases: string[] = [];
  for (let i = 0; i < rawWords.length - 1; i++) {
    const w = rawWords[i];
    const next = rawWords[i + 1];
    // Артикул = короткое слово (2-3 буквы) + цифра
    if (/^[a-zа-яё]{2,3}$/.test(w) && /^\d/.test(next)) {
      titleSearchPhrases.push(`${w} ${next}`);  // "ct 83", "ст 83"
    }
  }

  if (titleSearchPhrases.length > 0) {
    const titleFilters = titleSearchPhrases
      .map(p => `title.ilike.%${p}%`)
      .join(',');

    let step0Query = supabase
      .from('documents')
      .select('id')
      .or(titleFilters);

    if (manufacturer_id) {
      step0Query = step0Query.eq('manufacturer_id', manufacturer_id);
    }

    const { data: matchedDocs } = await step0Query;

    if (matchedDocs && matchedDocs.length > 0) {
      const docIds = matchedDocs.map(d => d.id);
      console.log(`0️⃣ Found docs by title: ${docIds.length}`, titleSearchPhrases);

      const { data: step0Chunks } = await supabase
        .from('document_chunks')
        .select(`
          id, content, chunk_index, document_id,
          doc_type, priority_weight, intent_tags, metadata,
          documents(id, title, manufacturers(name_ru))
        `)
        .in('document_id', docIds)
        .limit(limitChunks * 2);

      if (step0Chunks && step0Chunks.length >= 2) {
        console.log(`✅ Step 0: returning ${step0Chunks.length} chunks from title match`);
        return (step0Chunks as Record<string, unknown>[]).map(normalizeChunk);
      }
    }
  }

  // 1. Новая RPC get_ai_context (приоритет + фильтры)
  if (query.length >= 2) {
    console.log('1️⃣ Trying get_ai_context RPC...');
    const { data: rpcNew, error: rpcNewErr } = await supabase.rpc('get_ai_context', {
      p_query:       query,
      p_product_id:  product_id,
      p_manufacturer_id: manufacturer_id,
      p_category_id: category_id,
      p_doc_types:   doc_types_arr,
      p_intent_tags: intent_tags,
      p_limit:       limitChunks * 2,
    })

    if (!rpcNewErr && rpcNew?.length) {
      console.log('✅ Found N chunks via get_ai_context:', rpcNew.length);

      const mapRpcRows = (rows: ChunkRow[]) =>
        rows.map(r => ({
          id:              r.chunk_id ?? r.id,
          content:         r.chunk_content ?? r.content,
          chunk_index:     0,
          document_id:     '',
          doc_type:        r.doc_type,
          priority_weight: r.priority_weight,
          intent_tags:     r.intent_tags,
          metadata:        r.metadata,
          documents: {
            id:            '',
            title:         r.doc_title ?? '',
            manufacturers: r.manufacturer ? { name_ru: r.manufacturer } : undefined,
          },
          product_name: r.product_name,
          product_kod:  r.product_kod,
          rank:         r.rank,
        }));

      // Если RPC не поддерживает фильтрацию производителя, фильтруем результаты здесь
      if (manufacturer_id && rpcNew?.length) {
        const filtered = (rpcNew as any[]).filter(r =>
          r.manufacturer_id === manufacturer_id ||
          r.document_manufacturer_id === manufacturer_id
        );
        if (filtered.length > 0) {
          return mapRpcRows(filtered as ChunkRow[]);
        }
        // Если после фильтрации пусто — идём дальше по fallback
        console.log(`⚠️ RPC не вернул нужного производителя (${manufacturer_id}), fallback...`);
      } else {
        return mapRpcRows(rpcNew as ChunkRow[]);
      }
    }
  }

  // 2. Старая RPC search_chunks_ranked (fallback)
  if (query.length >= 2) {
    const ftsQuery = query
      .trim()
      .split(/\s+/)
      .filter(w => w.length >= 2)
      .map(w => w + ':*')
      .join(' & ')

    if (ftsQuery) {
      console.log('2️⃣ Trying search_chunks_ranked, ftsQuery:', ftsQuery);
      const { data: rpcOld, error: rpcOldErr } = await supabase.rpc(
        'search_chunks_ranked',
        { search_query: ftsQuery, result_limit: limitChunks * 3 }
      )
      if (!rpcOldErr && rpcOld?.length) {
        console.log('✅ Found N chunks via search_chunks_ranked:', rpcOld.length);
        return (rpcOld as Record<string, unknown>[]).map(normalizeChunk)
      }

      // 3. FTS fallback
      console.log('3️⃣ Trying FTS textSearch...');
      const { data: ftsData, error: ftsErr } = await supabase
        .from('document_chunks')
        .select(`
          id, content, chunk_index, document_id,
          doc_type, priority_weight, intent_tags, metadata,
          documents(id, title, manufacturers(name_ru))
        `)
        .textSearch('content', ftsQuery, { type: 'websearch', config: 'russian' })
        .limit(limitChunks * 3)

      if (!ftsErr && ftsData?.length) {
        console.log('✅ Found N chunks via FTS textSearch:', ftsData.length);
        return (ftsData as Record<string, unknown>[]).map(normalizeChunk)
      }
    }
  }

  // 4. ILIKE последний шанс
  if (query.length >= 2) {
    console.log('4️⃣ Trying ILIKE with query:', query);
    const words = query.split(/\s+/).filter(w => w.length >= 2);

    // Формируем фразы артикулов (например "ct 83", "cm 11")
    const articlePhrases: string[] = [];
    for (let i = 0; i < words.length - 1; i++) {
      const w = words[i];
      const next = words[i + 1];
      if (/^[a-zа-яё]{2,3}$/i.test(w) && /^\d+/.test(next)) {
        articlePhrases.push(`${w} ${next}`);
        articlePhrases.push(`${w}${next}`);
      }
    }

    // 4а. Сначала ищем по названию документа (высший приоритет)
    if (articlePhrases.length > 0) {
      let titleQuery = supabase
        .from('document_chunks')
        .select(`
          id, content, chunk_index, document_id,
          doc_type, priority_weight, intent_tags, metadata,
          documents!inner(id, title, manufacturer_id, manufacturers(name_ru))
        `)
        .or(articlePhrases.map(p => `documents.title.ilike.%${p}%`).join(','))
        .limit(limitChunks * 2);

      if (manufacturer_id) {
        titleQuery = titleQuery.eq('documents.manufacturer_id', manufacturer_id);
      }

      const { data: titleData } = await titleQuery;

      if (titleData && titleData.length >= 3) {
        console.log(`✅ Found ${titleData.length} chunks by title`);
        return (titleData as Record<string, unknown>[]).map(normalizeChunk);
      }
    }

    // 4б. Fallback — поиск по содержимому
    let ilikeQuery = supabase
      .from('document_chunks')
      .select(`
        id, content, chunk_index, document_id,
        doc_type, priority_weight, intent_tags, metadata,
        documents!inner(id, title, manufacturer_id, manufacturers(name_ru))
      `)
      .or(words.map(w => `content.ilike.%${w}%`).join(','))
      .limit(limitChunks * 2);

    if (manufacturer_id) {
      ilikeQuery = ilikeQuery.eq('documents.manufacturer_id', manufacturer_id);
    }

    const { data: ilikeData } = await ilikeQuery;
    console.log('✅ Found N chunks via ILIKE (content):', ilikeData?.length ?? 0);
    return ((ilikeData ?? []) as Record<string, unknown>[]).map(normalizeChunk);
  }

  return []
}

// ─── дедупликация ─────────────────────────────────────────────
function deduplicateChunks(chunks: ChunkRow[], limit: number): ChunkRow[] {
  const seenDocs    = new Map<string, number>()
  const seenContent = new Set<string>()
  const result: ChunkRow[] = []

  for (const chunk of chunks) {
    if (result.length >= limit) break
    const normalized = chunk.content?.replace(/\s+/g, ' ').trim().slice(0, 200)
    if (seenContent.has(normalized)) continue
    const docCount = seenDocs.get(chunk.document_id) || 0
    if (docCount >= 2) continue
    seenContent.add(normalized)
    seenDocs.set(chunk.document_id, docCount + 1)
    result.push(chunk)
  }
  return result
}

// ─── формирование контекста для n8n ──────────────────────────
function buildContext(
  query: string,
  products: any[],
  rules: any[],
  notes: any[],
  chunks: ChunkRow[],
  nomenclature: { id: string; code?: string | null; article?: string | null; name?: string | null; brand?: string | null }[] = [],
  nomenclatureAnalogs: { id: string; code?: string | null; article?: string | null; name?: string | null; brand?: string | null }[] = [],
  nomenclatureAccessories: { id: string; code?: string | null; article?: string | null; name?: string | null; brand?: string | null }[] = [],
  requestedInvoiceItems: { id: string; code?: string | null; article?: string | null; name?: string | null; brand?: string | null }[] = []
): string {
  const lines: string[] = [`# База знаний — контекст\n**Запрос:** ${query}\n`]
  lines.push('## Приоритет брендов для предложения менеджеру')
  lines.push('1. BASWOOL — основной контракт, предлагать ПЕРВЫМ для минваты')
  lines.push('2. ROCKWOOL — второй приоритет для минваты')
  lines.push('3. ТЕХНОНИКОЛЬ — только XPS экструзия и гидроизоляция (НЕ минвата)')
  lines.push('4. ИКОПАЛ — гидроизоляция')
  lines.push('5. ЦЕРЕЗИТ/ОСНОВИТ/ПЛИТОНИТ — сухие смеси и клеи')
  lines.push('⚠️ ВАЖНО: Всегда предлагать сопутствующие товары: мембрана + крепёж + анкера')
  lines.push('')

  // Чанки — с новыми полями приоритета и типа документа
  if (chunks.length) {
    lines.push('## Из технической документации (PDF)')
    for (const c of chunks) {
      const doc     = c.documents
      const title   = doc?.title || c.doc_title || 'Документ'
      const mfrRaw = c.documents?.manufacturers
      const mfr = (Array.isArray(mfrRaw) ? mfrRaw[0] : mfrRaw)?.name_ru ?? c.manufacturer
      const docType = c.doc_type ? `[${c.doc_type.toUpperCase()}]` : ''
      const prio    = c.priority_weight ? ` приоритет ${c.priority_weight}/10` : ''
      const prod    = c.product_name ? ` | ${c.product_name} (${c.product_kod})` : ''

      lines.push(`### ${docType} ${title}${mfr ? ` (${mfr})` : ''}${prio}${prod}`)

      // технические атрибуты из metadata
      if (c.metadata) {
        const m = c.metadata as Record<string, unknown>
        const specs = [
          m['coating']    ? `Покрытие: ${m['coating']}`          : '',
          m['density']    ? `Плотность: ${m['density']} кг/м³`   : '',
          m['thickness']  ? `Толщина: ${m['thickness']} мм`      : '',
          m['temp_max']   ? `Темп. макс: ${m['temp_max']}°С`     : '',
          m['gost']       ? `ГОСТ: ${m['gost']}`                 : '',
        ].filter(Boolean).join(' | ')
        if (specs) lines.push(`*${specs}*`)
      }

      lines.push(makeSnippet(c.content, query))
      lines.push('')
    }
  }

  // Продукты — теперь с kod_1c и плотностью
  if (products.length) {
    lines.push('## Продукты в каталоге')
    for (const p of products) {
      const coating  = p.coating   ? ` | покрытие: ${p.coating}`     : ''
      const density  = p.density   ? ` | ${p.density} кг/м³`         : ''
      const thick    = p.thickness ? ` | толщина: ${p.thickness} мм` : ''
      const stock    = p.in_stock  ? '' : ' | ⚠ нет в наличии'
      lines.push(
        `- **${p.name}** (${p.kod_1c ?? '—'}) | ${p.flammability} | T до ${p.temp_max}°C` +
        `${coating}${density}${thick} | ДУ ${p.diameter_min}–${p.diameter_max}${stock}`
      )
    }
    lines.push('')
  }

  if (nomenclature.length) {
    lines.push('## Номенклатура 1С')
    for (const n of nomenclature) {
      const codePart = n.code ? ` | код 1С: ${n.code}` : ' | код 1С не найден'
      const articlePart = n.article ? ` (article: ${n.article})` : ''
      const brandPart = n.brand ? ` | ${n.brand}` : ''
      lines.push(`- **${n.name ?? '—'}**${articlePart}${codePart}${brandPart}`)
    }
    lines.push('')
  }

  if (requestedInvoiceItems.length) {
    lines.push('## Найденные позиции для счета по точным строкам запроса')
    for (const n of requestedInvoiceItems) {
      const codePart = n.code ? `code: ${n.code}` : 'code: —'
      const articlePart = n.article ? ` | article: ${n.article}` : ''
      lines.push(`- **${n.name ?? '—'}** (${codePart}${articlePart})`)
    }
    lines.push('')
  }

  if (nomenclatureAnalogs.length) {
    lines.push('## Аналоги из номенклатуры 1С')
    for (const n of nomenclatureAnalogs) {
      const codePart = n.code ? ` | код 1С: ${n.code}` : ' | код 1С не найден'
      const articlePart = n.article ? ` (article: ${n.article})` : ''
      const brandPart = n.brand ? ` | ${n.brand}` : ''
      lines.push(`- **${n.name ?? '—'}**${articlePart}${codePart}${brandPart}`)
    }
    lines.push('')
  }

  if (nomenclatureAccessories.length) {
    lines.push('## Сопутствующие товары / аксессуары 1С')
    for (const n of nomenclatureAccessories) {
      const codePart = n.code ? ` | код 1С: ${n.code}` : ' | код 1С не найден'
      const articlePart = n.article ? ` (article: ${n.article})` : ''
      const brandPart = n.brand ? ` | ${n.brand}` : ''
      lines.push(`- **${n.name ?? '—'}**${articlePart}${codePart}${brandPart}`)
    }
    lines.push('')
  }

  if (rules.length) {
    lines.push('## Правила подбора')
    for (const r of rules) lines.push(`- **${r.title}**: ${r.recommendation}`)
    lines.push('')
  }

  if (notes.length) {
    lines.push('## Заметки')
    for (const n of notes) {
      lines.push(`### ${n.title}`)
      lines.push(String(n.content).slice(0, 400))
      lines.push('')
    }
  }

  return lines.join('\n')
}

// ─── утилиты (без изменений) ──────────────────────────────────
function detectContext(query: string) {
  const manufacturers = ['rockwool', 'isover', 'knauf', 'технониколь', 'paroc', 'ursa', 'экоролл']
    .filter(m => query.toLowerCase().includes(m))
  const du_values = (query.match(/\b(\d{2,3})\b/g) || []).map(Number)
  return { manufacturers, du_values, keywords: [] }
}

function makeSnippet(text: string, query: string, ctx = 200): string {
  if (!text) return ''
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2)
  let bestIdx = -1
  for (const w of words) {
    const idx = text.toLowerCase().indexOf(w)
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx
  }
  if (bestIdx === -1) return text.slice(0, ctx * 2).trim() + '...'
  const start = Math.max(0, bestIdx - ctx)
  const end   = Math.min(text.length, bestIdx + ctx)
  return (start > 0 ? '...' : '') + text.slice(start, end).trim() + (end < text.length ? '...' : '')
}
