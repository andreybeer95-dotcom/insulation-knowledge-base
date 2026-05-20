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
  const compactMode = ['1', 'true', 'yes', 'invoice'].includes(
    (searchParams.get('compact') || searchParams.get('mode') || '').toLowerCase()
  )
  const toolResponseMode = ['tool', 'n8n', 'agent', 'short'].includes(
    (searchParams.get('response') || searchParams.get('format') || '').toLowerCase()
  )

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
  const hasCylinderQueryForNomenclature = /цилиндр|цилиндры|скорлуп|xotpipe|хотпайп/i.test(rawQuery)
  const hasVentFacadeQueryForNomenclature = /вент\s*фасад|вентфасад|нфс|навесн\w*\s+фасад|сайдинг/i.test(rawQuery)
  const hasMultiStoreyFacadeQueryForNomenclature =
    hasVentFacadeQueryForNomenclature &&
    /(поликлиник|обществен|этажност\D*(?:[3-9]|\d{2,})|(?:[3-9]|\d{2,})\s*[- ]?этаж)/i.test(rawQuery)
  const hasRoofWoolQueryForNomenclature =
    /техноруф|(?:^|\s)руф\s*[нв]?\b|кровельн\w*\s+утепл|утеплител\w*\s+кровл/i.test(rawQuery)
  const hasConstructionInsulationQueryForNomenclature =
    !hasCylinderQueryForNomenclature &&
    (
      hasVentFacadeQueryForNomenclature ||
      hasRoofWoolQueryForNomenclature ||
      /мин\s*ват|минерал|каменн\w*\s+ват|baswool|басвул|rockwool|роквул|техновент|технофас|фасадн\w*\s+утеплител|утеплител\w*\s+(фасад|стен|кровл|сайдинг)/i.test(rawQuery)
    )
  const hasPvcMembraneQueryForNomenclature =
    /пвх|pvc|мембран|пластфойл|plastfoil|logicroof|ecoplast|ecobase|logicbase/i.test(rawQuery) &&
    !hasCylinderQueryForNomenclature
  const pvcMembraneThicknesses = Array.from(
    rawQuery.matchAll(/(\d\s*[,\.]\s*\d|\d{1,2})\s*(?:мм|mm)?/gi)
  )
    .map((match) => match[1].replace(/\s+/g, '').replace('.', ','))
    .filter((value) => /^(?:1,2|1,5|1,8|2,0|2)$/.test(value))
  const isBareThicknessOnly =
    queryNumbers.length === 1 &&
    /^(?:\s*(?:толщина|толщиной|утеплитель|мм|mm)\s*)*\d{2,3}\s*(?:мм|mm)?\s*$/i.test(rawQuery)
  const constructionThicknesses = queryNumbers.filter((n) => {
    const value = Number(n)
    return value >= 30 && value <= 300
  })

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
    product_category_type?: string | null
    code_1c_parent?: string | null
    revenue_3y?: number | null
    qty_3y?: number | null
    is_active?: boolean | null
    is_old?: boolean | null
  }

  type RequestedInvoiceLine = {
    line: string
    article: string
    quantity: string | null
    unit: string | null
    found_item?: NomenclatureItem | null
  }

  let relevant_nomenclature: NomenclatureItem[] = []
  let nomenclature_analogs: NomenclatureItem[] = []
  let nomenclature_accessories: NomenclatureItem[] = []
  let requested_invoice_items: NomenclatureItem[] = []
  let requested_invoice_lines: RequestedInvoiceLine[] = []
  let missing_invoice_items: RequestedInvoiceLine[] = []

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

  const isPvcMembraneNomenclature = (name?: string | null) =>
    /пвх|pvc|пластфойл|plastfoil|logicroof|ecoplast|ecobase|logicbase/i.test(name || '') &&
    /мембран|plastfoil|пластфойл|logicroof|ecoplast|ecobase|logicbase/i.test(name || '') &&
    !/клей|мастик|праймер|лента|угол|аэратор|усиление|воронк|дорожк|саморез|крепеж|очистител|герметик/i.test(name || '')

  const hasMembraneThickness = (name: string | null | undefined, thickness: string) => {
    const text = name || ''
    const normalized = thickness.replace('.', ',')
    const dot = normalized.replace(',', '\\.')
    const comma = normalized.replace(',', ',')
    const compact = normalized.replace(',', '[,.]')
    return [
      new RegExp(`(^|\\D)${compact}\\s*(?:мм|mm|[xх*])`, 'i'),
      new RegExp(`[xх*]\\s*${compact}(\\D|$)`, 'i'),
      new RegExp(`\\(${compact}\\s*[xх*]`, 'i'),
      new RegExp(`(^|\\D)${comma}\\s*(?:мм|mm|[xх*])`, 'i'),
      new RegExp(`(^|\\D)${dot}\\s*(?:мм|mm|[xх*])`, 'i'),
    ].some((pattern) => pattern.test(text))
  }

  const sortPvcMembranes = (items: NomenclatureItem[]) => {
    const score = (item: NomenclatureItem) => {
      const text = `${item.brand || ''} ${item.name || ''}`.toLowerCase()
      let value = 100
      if (/logicroof\s+v-rp/i.test(text)) value -= 50
      if (/ecoplast\s+v-rp/i.test(text)) value -= 45
      if (/пластфойл|plastfoil/i.test(text)) value -= 35
      if (/logicroof/i.test(text)) value -= 30
      if (/ecoplast/i.test(text)) value -= 25
      if (/ecobase|logicbase/i.test(text)) value += 20
      if (/v-sl|v-st|v-uv/i.test(text)) value += 15
      if (/пвх|pvc|мембран/i.test(text)) value -= 5
      return value
    }
    return [...items].sort((a, b) => {
      const scoreDiff = score(a) - score(b)
      if (scoreDiff !== 0) return scoreDiff
      return (a.name || '').localeCompare(b.name || '', 'ru')
    })
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

  const normalizeInvoiceLine = (line: string) => line.replace(/\s+/g, ' ').trim()

  const splitRequestedInvoiceLines = (text: string) => {
    const physicalLines = text
      .replace(/\r/g, '\n')
      .split(/\n+/)
      .map(normalizeInvoiceLine)
      .filter(Boolean)

    const joined = physicalLines.length > 1 ? physicalLines.join('\n') : text
    const xotpipeParts = joined
      .split(/(?=\bXOTPIPE\b)/i)
      .map(normalizeInvoiceLine)
      .filter((line) => /^XOTPIPE\b/i.test(line))

    if (xotpipeParts.length > 1) return xotpipeParts

    return physicalLines.filter((line) =>
      /\bXOTPIPE\b|\bO-ME-ZN\b|\bSP[-\s]*\d{2,3}\b/i.test(line)
    )
  }

  const getInvoiceQuantity = (line: string) => {
    const match = line.match(/---\s*([\d,.]+)\s*([^\s]+(?:\s+[^\s]+)?)/i)
    if (!match) return { quantity: null, unit: null }
    return {
      quantity: match[1].replace(',', '.'),
      unit: normalizeInvoiceLine(match[2]),
    }
  }

  const getInvoiceSize = (line: string) => {
    const matches = Array.from(line.matchAll(/(\d{2,4})\s*[xх*]\s*(\d{1,4})(?:\s*[xх*]\s*(\d{3,4}))?/gi))
    if (!matches.length) return null
    const match = matches.find((item) => item[3]) ?? matches[0]
    return {
      first: match[1],
      second: match[2],
      third: match[3] ?? null,
    }
  }

  const getInvoiceAngle = (line: string) =>
    line.match(/\bL[-\s]*(?:1[-\s]*)?(30|45|60|90)\b/i)?.[1] ??
    line.match(/отвод\s*(30|45|60|90)/i)?.[1] ??
    null

  const buildArticleFromInvoiceLine = (line: string) => {
    const normalized = normalizeInvoiceLine(line)

    const omeElbowMatch = normalized.match(/\bO-ME-ZN\s+L-1-(30|45|60|90)\s+(\d{2,4})\b/i)
    if (omeElbowMatch) {
      return `OMEZNL1${omeElbowMatch[1]}D${omeElbowMatch[2]}`
    }

    const omeShellMatch = normalized.match(/\bO-ME-ZN\s+(\d{2,4})\s*[xх*]\s*(\d{3,4})\b/i)
    if (omeShellMatch) {
      return `OMEZNLD${omeShellMatch[2]}-${omeShellMatch[1]}`
    }

    const spSeries = normalized.match(/\bSP[-\s]*(\d{2,3})\b/i)?.[1]
    const size = getInvoiceSize(normalized)
    if (!spSeries || !size) return null

    // For invoice mode we generate an exact article only when the requested coating is explicit.
    // Unknown coating stays unresolved instead of becoming a guessed счет position.
    if (!/без\s+покрыт/i.test(normalized)) return null

    const angle = getInvoiceAngle(normalized)
    if (angle) {
      return `SP${spSeries}L${angle}DT${size.first}-${size.second}`
    }

    if (/цилиндр|скорлуп|[xх*]\s*\d{3,4}\b/i.test(normalized)) {
      return `SP${spSeries}L10DT${size.first}-${size.second}`
    }

    return null
  }

  const extractRequestedInvoiceLines = () => {
    const lines = splitRequestedInvoiceLines(rawQuery)
    const result: RequestedInvoiceLine[] = []
    for (const line of lines) {
      const article = buildArticleFromInvoiceLine(line)
      if (!article) continue
      const { quantity, unit } = getInvoiceQuantity(line)
      result.push({
        line,
        article,
        quantity,
        unit,
        found_item: null,
      })
    }
    return result
  }

  const enrichNomenclatureWithProductMeta = async (items: NomenclatureItem[]) => {
    const codes = Array.from(new Set(items.map((item) => item.code).filter(Boolean))) as string[]
    if (codes.length === 0) return items

    const { data } = await supabase
      .from('products')
      .select('kod_1c, category_type, code_1c_parent, revenue_3y, qty_3y, is_active, is_old')
      .in('kod_1c', codes)
      .limit(codes.length)

    const metaByCode = new Map(
      (data ?? []).map((row: any) => [row.kod_1c as string, row])
    )

    return items.map((item) => {
      const meta = item.code ? metaByCode.get(item.code) : null
      if (!meta) return item
      return {
        ...item,
        product_category_type: meta.category_type ?? null,
        code_1c_parent: meta.code_1c_parent ?? null,
        revenue_3y: meta.revenue_3y === null || meta.revenue_3y === undefined ? null : Number(meta.revenue_3y),
        qty_3y: meta.qty_3y === null || meta.qty_3y === undefined ? null : Number(meta.qty_3y),
        is_active: meta.is_active ?? null,
        is_old: meta.is_old ?? null,
      }
    })
  }

  const relinkInvoiceLines = () => {
    const invoiceItemByArticle = new Map(
      requested_invoice_items
        .filter((item) => item.article)
        .map((item) => [item.article as string, item])
    )
    requested_invoice_lines = requested_invoice_lines.map((line) => ({
      ...line,
      found_item: invoiceItemByArticle.get(line.article) ?? null,
    }))
    missing_invoice_items = requested_invoice_lines.filter((line) => !line.found_item)
  }

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

  const getBoardThickness = (name?: string | null) => {
    const text = name || ''
    const matches = Array.from(text.matchAll(/[xх*]\s*(\d{2,3})(?=\D|$)/gi))
    const last = matches.length > 0 ? matches[matches.length - 1]?.[1] : undefined
    return last ? Number(last) : null
  }

  const getBaswoolFacadeDensity = (name?: string | null) => {
    const text = name || ''
    const rawDensity = text.match(/ВЕНТ\s+ФАСАД\s*(\d{2,3})/i)?.[1]
    return rawDensity ? Number(rawDensity) : null
  }

  const getBaswoolLightDensity = (name?: string | null) => {
    const text = name || ''
    const rawDensity = text.match(/ЛАЙТ[-\s]*(35|45)/i)?.[1]
    return rawDensity ? Number(rawDensity) : null
  }

  const getBaswoolRoofRole = (name?: string | null) => {
    const text = name || ''
    if (/РУФ\s+Н/i.test(text)) return 'lower'
    if (/РУФ\s+В/i.test(text)) return 'upper'
    return 'single'
  }

  const getBaswoolRoofGrade = (name?: string | null) => {
    const text = name || ''
    const rawGrade = text.match(/РУФ\s+[НВ]\s*(\d{2,3})/i)?.[1] ?? text.match(/РУФ\s*(\d{2,3})/i)?.[1]
    return rawGrade ? Number(rawGrade) : null
  }

  const sortBaswoolFacade = (items: NomenclatureItem[], preferredThicknesses: string[]) => {
    const thicknessPreference = preferredThicknesses.map(Number).filter(Boolean)
    const densityPreference = [90, 80, 70]
    return [...items].sort((a, b) => {
      const aThickness = getBoardThickness(a.name)
      const bThickness = getBoardThickness(b.name)
      const aThicknessRank = aThickness ? thicknessPreference.indexOf(aThickness) : -1
      const bThicknessRank = bThickness ? thicknessPreference.indexOf(bThickness) : -1
      const normalizedAThicknessRank = aThicknessRank === -1 ? 99 : aThicknessRank
      const normalizedBThicknessRank = bThicknessRank === -1 ? 99 : bThicknessRank
      if (normalizedAThicknessRank !== normalizedBThicknessRank) return normalizedAThicknessRank - normalizedBThicknessRank

      const aDensity = getBaswoolFacadeDensity(a.name)
      const bDensity = getBaswoolFacadeDensity(b.name)
      const aDensityRank = aDensity ? densityPreference.indexOf(aDensity) : -1
      const bDensityRank = bDensity ? densityPreference.indexOf(bDensity) : -1
      const normalizedADensityRank = aDensityRank === -1 ? 99 : aDensityRank
      const normalizedBDensityRank = bDensityRank === -1 ? 99 : bDensityRank
      if (normalizedADensityRank !== normalizedBDensityRank) return normalizedADensityRank - normalizedBDensityRank

      return (a.name || '').localeCompare(b.name || '', 'ru')
    })
  }

  const sortBaswoolLight = (items: NomenclatureItem[], preferredThicknesses: string[]) => {
    const thicknessPreference = preferredThicknesses.map(Number).filter(Boolean)
    const densityPreference = [45, 35]
    return [...items].sort((a, b) => {
      const aDensityRank = densityPreference.indexOf(getBaswoolLightDensity(a.name) ?? 0)
      const bDensityRank = densityPreference.indexOf(getBaswoolLightDensity(b.name) ?? 0)
      const normalizedADensityRank = aDensityRank === -1 ? 99 : aDensityRank
      const normalizedBDensityRank = bDensityRank === -1 ? 99 : bDensityRank
      if (normalizedADensityRank !== normalizedBDensityRank) return normalizedADensityRank - normalizedBDensityRank

      const aThicknessRank = thicknessPreference.indexOf(getBoardThickness(a.name) ?? 0)
      const bThicknessRank = thicknessPreference.indexOf(getBoardThickness(b.name) ?? 0)
      const normalizedAThicknessRank = aThicknessRank === -1 ? 99 : aThicknessRank
      const normalizedBThicknessRank = bThicknessRank === -1 ? 99 : bThicknessRank
      if (normalizedAThicknessRank !== normalizedBThicknessRank) return normalizedAThicknessRank - normalizedBThicknessRank

      return (a.name || '').localeCompare(b.name || '', 'ru')
    })
  }

  const sortBaswoolRoof = (
    items: NomenclatureItem[],
    preferredThicknesses: string[],
    preferredGrades: number[]
  ) => {
    const thicknessPreference = preferredThicknesses.map(Number).filter(Boolean)
    return [...items].sort((a, b) => {
      const aThicknessRank = thicknessPreference.indexOf(getBoardThickness(a.name) ?? 0)
      const bThicknessRank = thicknessPreference.indexOf(getBoardThickness(b.name) ?? 0)
      const normalizedAThicknessRank = aThicknessRank === -1 ? 99 : aThicknessRank
      const normalizedBThicknessRank = bThicknessRank === -1 ? 99 : bThicknessRank
      if (normalizedAThicknessRank !== normalizedBThicknessRank) return normalizedAThicknessRank - normalizedBThicknessRank

      const aGradeRank = preferredGrades.indexOf(getBaswoolRoofGrade(a.name) ?? 0)
      const bGradeRank = preferredGrades.indexOf(getBaswoolRoofGrade(b.name) ?? 0)
      const normalizedAGradeRank = aGradeRank === -1 ? 99 : aGradeRank
      const normalizedBGradeRank = bGradeRank === -1 ? 99 : bGradeRank
      if (normalizedAGradeRank !== normalizedBGradeRank) return normalizedAGradeRank - normalizedBGradeRank

      const aRevenue = a.revenue_3y ?? 0
      const bRevenue = b.revenue_3y ?? 0
      if (aRevenue !== bRevenue) return bRevenue - aRevenue

      return (a.name || '').localeCompare(b.name || '', 'ru')
    })
  }

  if (queryNumbers.length > 0 && !isBareThicknessOnly) {
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

    requested_invoice_lines = extractRequestedInvoiceLines()

    const requestedInvoiceArticles = new Set<string>(
      requested_invoice_lines.map((line) => line.article)
    )

    if (requestedInvoiceArticles.size === 0) {
      addRequestedInvoiceArticles(requestedInvoiceArticles)
    }

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
      relinkInvoiceLines()
    }
  }

  if (hasPvcMembraneQueryForNomenclature && !isBareThicknessOnly) {
    const pvcQueries = await Promise.all([
      supabase
        .from('nomenclature_1c')
        .select('id, code, article, name, brand')
        .or('name.ilike.%ПЛАСТФОЙЛ%,name.ilike.%Plastfoil%')
        .limit(120),
      supabase
        .from('nomenclature_1c')
        .select('id, code, article, name, brand')
        .or('name.ilike.%LOGICROOF%,name.ilike.%Logicroof%')
        .limit(120),
      supabase
        .from('nomenclature_1c')
        .select('id, code, article, name, brand')
        .or('name.ilike.%Ecoplast%,name.ilike.%Ecobase%,name.ilike.%Logicbase%')
        .limit(120),
      supabase
        .from('nomenclature_1c')
        .select('id, code, article, name, brand')
        .or('name.ilike.%ПВХ%,name.ilike.%PVC%')
        .limit(120),
    ])

    let pvcCandidates = dedupeNomenclature(
      pvcQueries.flatMap((result) => (result.data ?? []) as NomenclatureItem[])
    ).filter((item) => isPvcMembraneNomenclature(item.name))

    const requestedPvcThicknesses = pvcMembraneThicknesses.length > 0
      ? pvcMembraneThicknesses
      : /1\s*[,\.]\s*5/i.test(rawQuery)
        ? ['1,5']
        : []

    if (requestedPvcThicknesses.length > 0) {
      pvcCandidates = pvcCandidates.filter((item) =>
        requestedPvcThicknesses.some((thickness) => hasMembraneThickness(item.name, thickness))
      )
    }

    const isPlastfoilItem = (item: NomenclatureItem) =>
      /пластфойл|plastfoil/i.test(`${item.brand || ''} ${item.name || ''}`)

    const wantsAnalogForPlastfoil =
      /пластфойл|plastfoil/i.test(rawQuery) &&
      /аналог|замен|вместо|альтернатив|analog|replacement|alternative/i.test(rawQuery)

    const plastfoilItems = sortPvcMembranes(pvcCandidates.filter(isPlastfoilItem))
    const nonPlastfoilItems = sortPvcMembranes(pvcCandidates.filter((item) => !isPlastfoilItem(item)))
    const explicitPvcSeriesMatcher = /ecoplast/i.test(rawQuery)
      ? /ecoplast/i
      : /logicroof/i.test(rawQuery)
        ? /logicroof/i
        : /plastfoil|пластфойл/i.test(rawQuery) && !wantsAnalogForPlastfoil
          ? /plastfoil|пластфойл/i
          : null
    const explicitPvcItems = explicitPvcSeriesMatcher
      ? sortPvcMembranes(pvcCandidates.filter((item) =>
          explicitPvcSeriesMatcher.test(`${item.brand || ''} ${item.name || ''}`)
        ))
      : []
    const otherPvcItems = explicitPvcSeriesMatcher
      ? sortPvcMembranes(pvcCandidates.filter((item) =>
          !explicitPvcSeriesMatcher.test(`${item.brand || ''} ${item.name || ''}`)
        ))
      : []

    if (wantsAnalogForPlastfoil) {
      relevant_nomenclature = dedupeNomenclature([
        ...nonPlastfoilItems,
        ...relevant_nomenclature,
      ]).slice(0, 12)
      nomenclature_analogs = dedupeNomenclature([
        ...plastfoilItems,
        ...nomenclature_analogs,
      ]).slice(0, 12)
    } else {
      const preferredPvcItems = explicitPvcItems.length > 0
        ? [...explicitPvcItems, ...otherPvcItems]
        : [...plastfoilItems, ...nonPlastfoilItems]
      relevant_nomenclature = dedupeNomenclature([
        ...preferredPvcItems,
        ...relevant_nomenclature,
      ]).slice(0, 12)
    }

    const needsPvcRoofAccessoryContext =
      /кровл|крыша|roof|доп|сопутств|комплект|аксессуар|400|расчет|рассчитать|креп[её]ж|клей|стеклохолст|геотекст|воронк|планк|termoclip|bond/i.test(rawQuery)

    if (needsPvcRoofAccessoryContext) {
      const preferredAccessoryCodes = [
        'ЦВ000225423', // Стеклохолст ТехноНИКОЛЬ 100 г/м2 (400 м2)
        'ЦВ000218357', // Стеклохолст ТехноНИКОЛЬ 100 г/м2 (100 м2)
        'ЦВ000209969', // LOGICROOF BOND 10 л
        'ЦВ000219591', // LOGICROOF BOND 5 л
        'ЦВ000012139', // Termoclip-кровля R 28/110
        'ЦВ000218747', // Termoclip-кровля R 28/70
        'ЦВ000246721', // ПВХ Металл 1x2м
        'ЦБ48182',     // ПВХ металл серый 1x2м
        'ЦВ000228797', // LOGICROOF MAST-PU
        'ЦВ000228799', // LOGICROOF MAST-PRIME
        'ЦВ000228798', // LOGICROOF MAST-AKS
        'ЦБ51290',     // LOGICROOF NG
        'ЦВ000229344', // LOGICROOF NG
        'ЦВ000206375', // LOGICROOF SelfPatch
      ]

      const { data: pvcAccessoryByCode } = await supabase
        .from('nomenclature_1c')
        .select('id, code, article, name, brand')
        .in('code', preferredAccessoryCodes)
        .limit(80)

      const orderByCode = new Map(preferredAccessoryCodes.map((code, index) => [code, index]))
      const pvcAccessoryItems = ((pvcAccessoryByCode ?? []) as NomenclatureItem[])
        .sort((a, b) => (orderByCode.get(a.code || '') ?? 999) - (orderByCode.get(b.code || '') ?? 999))

      nomenclature_accessories = dedupeNomenclature([
        ...pvcAccessoryItems,
        ...nomenclature_accessories,
      ]).slice(0, 24)
    }
  }

  if (hasRoofWoolQueryForNomenclature) {
    const lowerThicknesses = Array.from(rawQuery.matchAll(/(?:техноруф\s+н|(?:^|\s)н)(?:\s+проф|\s+оптим[ао]|\s+экстра)?\D{0,24}(\d{2,3})/gi))
      .map((match) => match[1])
    const upperThicknesses = Array.from(rawQuery.matchAll(/(?:техноруф\s+в|(?:^|\s)в)(?:\s+проф|\s+оптим[ао]|\s+экстра)?\D{0,24}(\d{2,3})/gi))
      .map((match) => match[1])
    const fallbackRoofThicknesses = constructionThicknesses.length > 0 ? constructionThicknesses : ['120', '50', '100']
    const preferredLowerThicknesses = lowerThicknesses.length > 0 ? lowerThicknesses : fallbackRoofThicknesses
    const preferredUpperThicknesses = upperThicknesses.length > 0 ? upperThicknesses : fallbackRoofThicknesses
    const wantsLowerLayer = lowerThicknesses.length > 0 || /техноруф\s+н|руф\s+н|(?:^|\s)н\s+(?:проф|оптим|экстра)|нижн/i.test(rawQuery)
    const wantsUpperLayer = upperThicknesses.length > 0 || /техноруф\s+в|руф\s+в|(?:^|\s)в\s+(?:проф|оптим|экстра)|верхн/i.test(rawQuery)

    const roofQueries: PromiseLike<{ data: any[] | null }>[] = []
    if (wantsLowerLayer || !wantsUpperLayer) {
      roofQueries.push(
        supabase
          .from('nomenclature_1c')
          .select('id, code, article, name, brand')
          .eq('brand', 'BASWOOL')
          .ilike('name', '%РУФ Н%')
          .limit(300)
      )
    }
    if (wantsUpperLayer || !wantsLowerLayer) {
      roofQueries.push(
        supabase
          .from('nomenclature_1c')
          .select('id, code, article, name, brand')
          .eq('brand', 'BASWOOL')
          .ilike('name', '%РУФ В%')
          .limit(300)
      )
    }

    const technoRoofQuery = supabase
      .from('nomenclature_1c')
      .select('id, code, article, name, brand')
      .eq('brand', 'ТЕХНОНИКОЛЬ')
      .ilike('name', '%ТЕХНОРУФ%')
      .limit(300)

    const [roofResults, technoRoofResult] = await Promise.all([
      Promise.all(roofQueries),
      technoRoofQuery,
    ])

    const roofCandidates = await enrichNomenclatureWithProductMeta(
      dedupeNomenclature(roofResults.flatMap((result) => (result.data ?? []) as NomenclatureItem[]))
    )

    const lowerItems = sortBaswoolRoof(
      roofCandidates.filter((item) =>
        getBaswoolRoofRole(item.name) === 'lower' &&
        preferredLowerThicknesses.some((thickness) => hasBoardThickness(item.name, thickness))
      ),
      preferredLowerThicknesses,
      /н\s+проф/i.test(rawQuery) ? [120, 110, 100] : [100, 110, 120]
    )

    const upperItems = sortBaswoolRoof(
      roofCandidates.filter((item) =>
        getBaswoolRoofRole(item.name) === 'upper' &&
        preferredUpperThicknesses.some((thickness) => hasBoardThickness(item.name, thickness))
      ),
      preferredUpperThicknesses,
      /в\s+оптим[ао]/i.test(rawQuery) ? [160, 170, 180, 190] : [170, 180, 160, 190]
    )

    const technoRoofItems = await enrichNomenclatureWithProductMeta(
      dedupeNomenclature(((technoRoofResult.data ?? []) as NomenclatureItem[]).filter((item) =>
        [...preferredLowerThicknesses, ...preferredUpperThicknesses].some((thickness) => hasBoardThickness(item.name, thickness))
      ))
    )
    const sortedTechnoRoofItems = [...technoRoofItems].sort((a, b) => {
      const score = (item: NomenclatureItem) => {
        const name = item.name || ''
        if (/ТЕХНОРУФ\s+Н\s+ПРОФ/i.test(name) && preferredLowerThicknesses.some((thickness) => hasBoardThickness(name, thickness))) return 0
        if (/ТЕХНОРУФ\s+В\s+ОПТИМ/i.test(name) && preferredUpperThicknesses.some((thickness) => hasBoardThickness(name, thickness))) return 1
        if (/ТЕХНОРУФ\s+Н/i.test(name) && preferredLowerThicknesses.some((thickness) => hasBoardThickness(name, thickness))) return 10
        if (/ТЕХНОРУФ\s+В/i.test(name) && preferredUpperThicknesses.some((thickness) => hasBoardThickness(name, thickness))) return 20
        return 99
      }
      const scoreDiff = score(a) - score(b)
      if (scoreDiff !== 0) return scoreDiff
      return (b.revenue_3y ?? 0) - (a.revenue_3y ?? 0)
    })

    relevant_nomenclature = dedupeNomenclature([
      ...lowerItems.slice(0, 4),
      ...upperItems.slice(0, 4),
    ]).slice(0, 12)

    nomenclature_analogs = dedupeNomenclature([
      ...sortedTechnoRoofItems,
      ...nomenclature_analogs,
    ]).slice(0, 12)
  }

  if (hasVentFacadeQueryForNomenclature) {
    const preferredThicknesses = constructionThicknesses.length > 0
      ? constructionThicknesses
      : hasMultiStoreyFacadeQueryForNomenclature ? ['100', '50', '150'] : ['150', '100']
    const thicknessFilters = preferredThicknesses.flatMap((thickness) => [
      `name.ilike.%*${thickness}%`,
      `name.ilike.%х${thickness}%`,
      `name.ilike.%-${thickness}%`,
    ]).join(',')

    let facadeQuery = supabase
      .from('nomenclature_1c')
      .select('id, code, article, name, brand')
      .eq('brand', 'BASWOOL')
      .ilike('name', '%ВЕНТ ФАСАД%')
      .limit(60)

    if (thicknessFilters) {
      facadeQuery = facadeQuery.or(thicknessFilters)
    }

    let lightQuery = supabase
      .from('nomenclature_1c')
      .select('id, code, article, name, brand')
      .eq('brand', 'BASWOOL')
      .or('name.ilike.%ЛАЙТ-35%,name.ilike.%ЛАЙТ-45%')
      .limit(60)

    const [{ data: facadeData }, { data: lightData }, { data: membraneData }, { data: bolgirusData }] = await Promise.all([
      facadeQuery,
      hasMultiStoreyFacadeQueryForNomenclature ? lightQuery : Promise.resolve({ data: [] }),
      supabase
        .from('nomenclature_1c')
        .select('id, code, article, name, brand')
        .eq('code', 'ЦВ000206651')
        .limit(1),
      supabase
        .from('nomenclature_1c')
        .select('id, code, article, name, brand')
        .or('name.ilike.%Болгирус%,name.ilike.%BOLGARYS%,name.ilike.%Bolgarys%')
        .limit(10),
    ])

    const facadeItems = sortBaswoolFacade((facadeData ?? []) as NomenclatureItem[], preferredThicknesses)
    const lightItems = sortBaswoolLight(
      ((lightData ?? []) as NomenclatureItem[]).filter((item) =>
        preferredThicknesses.some((thickness) => hasBoardThickness(item.name, thickness))
      ),
      preferredThicknesses
    )
    const existingVentFacadeItems = relevant_nomenclature.filter((item) =>
      /ВЕНТ\s+ФАСАД/i.test(item.name || '')
    )
    relevant_nomenclature = dedupeNomenclature([
      ...lightItems,
      ...facadeItems,
      ...existingVentFacadeItems,
    ]).slice(0, 20)

    nomenclature_accessories = dedupeNomenclature([
      ...((membraneData ?? []) as NomenclatureItem[]),
      ...((bolgirusData ?? []) as NomenclatureItem[]),
      ...nomenclature_accessories,
    ])
      .filter((item) => !/силма/i.test(item.name || ''))
      .slice(0, 20)
  }

  // Если очищенная 1С-номенклатура уже дала точные позиции, старый products не добавляем в контекст.
  if (relevant_nomenclature.length > 0 && (queryNumbers.length > 0 || hasConstructionInsulationQueryForNomenclature || hasPvcMembraneQueryForNomenclature)) {
    products = []
  }
  if (isBareThicknessOnly) {
    products = []
    relevant_nomenclature = []
    nomenclature_analogs = []
    nomenclature_accessories = []
  }

  ;[
    relevant_nomenclature,
    nomenclature_analogs,
    nomenclature_accessories,
    requested_invoice_items,
  ] = await Promise.all([
    enrichNomenclatureWithProductMeta(relevant_nomenclature),
    enrichNomenclatureWithProductMeta(nomenclature_analogs),
    enrichNomenclatureWithProductMeta(nomenclature_accessories),
    enrichNomenclatureWithProductMeta(requested_invoice_items),
  ])
  relinkInvoiceLines()

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
  const hasCylinderQueryForContext = hasCylinderQueryForNomenclature
  const hasVentFacadeQueryForContext = hasVentFacadeQueryForNomenclature
  const hasRoofWoolQueryForContext = hasRoofWoolQueryForNomenclature
  const hasConstructionInsulationQueryForContext = hasConstructionInsulationQueryForNomenclature
  const hasPvcMembraneQueryForContext = hasPvcMembraneQueryForNomenclature
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

  const chunks = isBareThicknessOnly
    ? []
    : deduplicateChunks(rawChunks.filter(chunkMatchesQueryTheme), limitChunks)
  const { data: rulesData } = await supabase
    .from('selection_rules')
    .select('id, rule_name, condition, rule_text, priority, is_prohibition, category')
    .order('priority', { ascending: true });

  const allRules = rulesData ?? [];

  // Фильтруем правила релевантные запросу
  const queryLower = query.toLowerCase();
  const ruleMatchesCurrentTopic = (rule: any) => {
    const category = String(rule.category || '').toLowerCase()
    const haystack = `${rule.category || ''} ${rule.condition || ''} ${rule.rule_name || ''} ${rule.rule_text || ''}`.toLowerCase()

    if (hasVentFacadeQueryForContext) {
      if (/стандарт/i.test(haystack) && !/без кода|не основн|запрет/i.test(haystack)) {
        return false
      }
      return ['общестрой', 'теплоизоляция', ''].includes(category) &&
        /вент|нфс|навесн|сайдинг|мембран|georex|болгирус|bolgarys|силма|без кода|не основн/i.test(haystack)
    }
    if (hasConstructionInsulationQueryForContext) {
      return ['общестрой', 'теплоизоляция', ''].includes(category)
    }
    if (hasPvcMembraneQueryForContext) {
      return ['кровельные мембраны', 'гидроизоляция', ''].includes(category)
    }
    if (hasGeotextileQueryForContext) {
      return ['геосинтетика', ''].includes(category)
    }
    if (hasXpsQueryForContext) {
      return ['теплоизоляция', 'гидроизоляция', 'общестрой', ''].includes(category)
    }
    if (hasCylinderQueryForContext) {
      return ['цилиндры', 'теплоизоляция', ''].includes(category)
    }
    return true
  }

  const relevantRules = isBareThicknessOnly ? [] : allRules.filter(rule => {
    if (!ruleMatchesCurrentTopic(rule)) return false
    const conditions = rule.condition.toLowerCase().split(/[,+\s]+/);
    return conditions.some((cond: string) =>
      cond.length > 2 && queryLower.includes(cond)
    );
  });

  const sortRulesForTopic = (rules: any[]) => {
    if (!hasConstructionInsulationQueryForContext) return rules
    return [...rules].sort((a, b) => {
      const score = (rule: any) => {
        const category = String(rule.category || '').toLowerCase()
        const haystack = `${rule.condition || ''} ${rule.rule_name || ''} ${rule.rule_text || ''}`.toLowerCase()
        let value = Number(rule.priority ?? 99) * 10
        if (category === 'общестрой') value -= 40
        if (/вент|нфс|навесн|сайдинг/i.test(haystack)) value -= 20
        if (/baswool|басвул/i.test(haystack)) value -= 5
        if (/без кода|не основн/i.test(haystack)) value -= 15
        if (/мембран|georex|болгирус|bolgarys/i.test(haystack)) value -= 10
        if (/сфтк|штукатур|рокфасад|руф|сэндвич/i.test(haystack)) value += 50
        return value
      }
      return score(a) - score(b)
    })
  }

  const topicProhibitionMatches = (rule: any) => {
    const haystack = `${rule.category || ''} ${rule.condition || ''} ${rule.rule_name || ''} ${rule.rule_text || ''}`.toLowerCase()
    if (hasGeotextileQueryForContext) return /геотекст|геоткан|дорнит|геосинтет|геореш|откос|склон|асфальт|площадк|парковк|нагруз/i.test(haystack)
    if (hasXpsQueryForContext) return /xps|пенополистирол|экструз|техноплекс|carbon/i.test(haystack)
    if (hasCylinderQueryForContext) return /цилиндр|труб|фольг|оцинк|котельн|шахт|xotpipe|хотпайп/i.test(haystack)
    return false
  }

  // Если релевантных нет — берём только тематические запреты, а не всю базу правил.
  const applicable_rules = isBareThicknessOnly ? [] : relevantRules.length > 0
    ? sortRulesForTopic(relevantRules).slice(0, hasConstructionInsulationQueryForContext ? 12 : 20)
    : sortRulesForTopic(allRules.filter(r => r.is_prohibition && topicProhibitionMatches(r))).slice(0, 12);

  const strictInvoiceMode = requested_invoice_lines.length > 0

  const selection_guidance = {
    clarification_needed: false,
    questions: [] as string[],
    answer_policy: [
      'Структура ответа менеджеру: 1) рекомендация; 2) код 1С; 3) сопутствующие товары; 4) что уточнить; 5) коротко почему.',
      'Отвечать коротко: обычно 5-8 строк. Не писать учебные объяснения, длинные характеристики, лямбды и прочность, если менеджер прямо не спросил.',
      'Если в ответе есть requested_invoice_items, считать этот блок приоритетным для готового счета: это точные строки запроса, найденные по артикулам/кодам 1С.',
      'Запрещено писать "нет в базе" по позиции, если она есть в requested_invoice_items. В таком случае нужно вывести найденный код 1С и артикул.',
      'Для цилиндров XOTPIPE система "без покрытия + оцинкованная окожушка" допустима и является правильным вариантом для улицы/защиты. Запрет "фольга + оцинковка" относится только к цилиндрам с покрытиями Alu/Alu1/фольга вместе с отдельной оцинкованной окожушкой.',
      'Нельзя применять правило "фольга + оцинковка" к цилиндрам без покрытия. Если в запросе "без покрытия + O-ME-ZN", писать, что комбинация допустима.',
      'Основной вариант для счета давать только из requested_invoice_items или relevant_nomenclature с кодом 1С. Позиции без кода 1С можно писать только как "кандидат, код нужно проверить".',
      'Не писать "нет в базе", пока не проверены relevant_nomenclature, nomenclature_accessories и точные размерные совпадения.',
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

  if (hasConstructionInsulationQueryForContext) {
    selection_guidance.answer_policy = [
      'Ответ менеджеру держать коротким: рекомендация, код 1С, сопутствующие товары, 1 короткая причина.',
      'Основной вариант можно давать только с кодом 1С из контекста. Если кода нет — не ставить позицию основным вариантом, писать "код нужно проверить".',
      'По минвате первым предлагать BASWOOL, вторым ROCKWOOL. ТЕХНОНИКОЛЬ по минвате не ставить первым; использовать прежде всего для XPS, гидроизоляции и профильных серий.',
      'Для вентфасада всегда проверить мембрану и фасадный крепёж. GEOREX NG можно предложить как НГ-мембрану, если проект требует мембрану.',
      'Фасадный крепёж: продвигать Болгирус. Если кода 1С Болгирус нет в контексте, написать "код Болгирус нужно проверить"; Силму не ставить основным вариантом.',
      'Не расписывать λ, плотность, прочность и длинное обоснование, если менеджер прямо не запросил техническое сравнение.',
    ]
    selection_guidance.analog_policy = [
      'ROCKWOOL давать как альтернативу после BASWOOL, если нужен второй вариант.',
      'BASWOOL ЛАЙТ 35/45 допустим только как внутренний слой двухслойной НФС, не как наружный слой.',
      'Наружный слой НФС: BASWOOL ВЕНТ ФАСАД 70/80/90. Для 3+ этажей и общественных зданий рассматривать двухслойную систему.',
    ]
    selection_guidance.recommendation_status = 'construction_manager_context'
  }

  if (hasRoofWoolQueryForContext) {
    selection_guidance.answer_policy = [
      'Запросы ТЕХНОРУФ/РУФ относятся к плоской кровле, не к вентфасаду. Не предлагать ВЕНТ ФАСАД вместо РУФ.',
      'Для двухслойной кровли: РУФ Н — нижний слой, РУФ В — верхний слой. Сохранять толщины из запроса по слоям.',
      'BASWOOL РУФ давать первым как коммерческий аналог, но если клиент просит именно ТЕХНОРУФ, исходные позиции ТЕХНОНИКОЛЬ можно указать отдельной строкой как запрошенный вариант из analogs.',
      ...selection_guidance.answer_policy,
    ]
  }

  if (strictInvoiceMode) {
    selection_guidance.answer_policy = [
      'Если missing_items не пустой, запрещено писать "все позиции найдены". Писать: "найдено X из Y, проверить: ...".',
      'В счёт включать только позиции из invoice_lines со статусом found или из requested_invoice_items. Нельзя брать код 1С из кандидатов/аналогов для другой строки.',
      'Ненайденную строку не заменять автоматически на другой угол, покрытие, серию или 2 x 45. Любая замена только как кандидат и только после согласования.',
      ...selection_guidance.answer_policy,
    ]

    if (missing_invoice_items.length > 0) {
      selection_guidance.clarification_needed = true
      selection_guidance.questions.unshift(
        `Проверить в 1С/у поставщика: ${missing_invoice_items.map((item) => item.article).join(', ')}.`
      )
    }
  }

  const hasUseCaseInQuery = /улиц|помещ|труб|отопл|хвс|гвс|вент|котельн|наруж|внутр|оцинк|фольг|нг|дренаж|дорог|откос|склон|асфальт|фундамент|кровл|фасад/i.test(rawQuery)
  const hasCylinderInResult = relevant_nomenclature.some((item) => getNomenclatureItemType(item.name) === 'cylinder')
  const hasGeotextileInQuery = /геотекст|дорнит|геоткан/i.test(rawQuery)

  if (queryNumbers.length === 0) {
    selection_guidance.clarification_needed = true
    if (hasConstructionInsulationQueryForContext) {
      selection_guidance.questions.push('Уточните толщину утепления и регион строительства.')
      if (hasVentFacadeQueryForContext) {
        selection_guidance.questions.push('Уточните, это полноценная НФС или обычная обрешетка под сайдинг.')
      }
    } else {
      selection_guidance.questions.push('Уточните размер/плотность/толщину материала, без этого можно показать только общий раздел номенклатуры.')
    }
  }

  if (isBareThicknessOnly) {
    selection_guidance.clarification_needed = true
    selection_guidance.questions = [
      'Уточните, к какому подбору относится толщина 150: вентфасад, кровля, XPS или цилиндры.',
      'Если это продолжение диалога по вентфасаду, повторите коротко: "вентфасад сайдинг 150".',
    ]
  }

  if (relevant_nomenclature.length > 1 && !hasConstructionInsulationQueryForContext) {
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

  if (hasVentFacadeQueryForContext) {
    if (!/мембран|нг|ветрозащит/i.test(rawQuery)) {
      selection_guidance.questions.push('Проверьте по проекту, нужна ли НГ/ветрозащитная мембрана.')
    }
    selection_guidance.questions = Array.from(new Set(selection_guidance.questions)).slice(0, 3)
    selection_guidance.clarification_needed = selection_guidance.questions.length > 0
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
  if (strictInvoiceMode) {
    const foundLines = requested_invoice_lines.filter((line) => line.found_item)
    formattedContext += '\n\n## Строгая проверка строк счета по 1С\n'
    formattedContext += `Найдено точных строк: ${foundLines.length} из ${requested_invoice_lines.length}.\n`
    formattedContext += 'Использовать в счете только найденные строки. Если есть ненайденные строки, не писать "все позиции найдены".\n'
    if (foundLines.length > 0) {
      formattedContext += '\nНайдено:\n'
      formattedContext += foundLines.map((line) => {
        const item = line.found_item
        const qtyPart = line.quantity ? ` | количество: ${line.quantity}${line.unit ? ` ${line.unit}` : ''}` : ''
        return `- ${item?.name ?? line.line} | код 1С: ${item?.code ?? '—'} | article: ${line.article}${qtyPart}`
      }).join('\n')
    }
    if (missing_invoice_items.length > 0) {
      formattedContext += '\n\nПроверить, точный код 1С не найден:\n'
      formattedContext += missing_invoice_items.map((line) => {
        const qtyPart = line.quantity ? ` | количество: ${line.quantity}${line.unit ? ` ${line.unit}` : ''}` : ''
        return `- ${line.line} | expected_article: ${line.article}${qtyPart}`
      }).join('\n')
      formattedContext += '\nАвтоматически не заменять на другой угол, покрытие, серию или 2 x 45.'
    }
  }
  if (selection_guidance.questions.length > 0) {
    formattedContext += '\n\n## Что нужно уточнить у менеджера\n'
    formattedContext += selection_guidance.questions.map(q => `- ${q}`).join('\n')
  }
  formattedContext += '\n\n## Жесткий контракт ответа менеджеру\n'
  formattedContext += [
    '- Максимум 5-8 строк, без длинных учебных объяснений.',
    '- Порядок: рекомендация -> код 1С -> сопутствующие -> уточнить -> почему.',
    '- Основной вариант только с кодом 1С из контекста. Без кода 1С — только кандидат/проверить код.',
    '- Если нужны вопросы, задать максимум 2-3 вопроса.',
    '- Не писать "в наличии", если в контексте нет подтвержденного остатка.',
  ].join('\n')
  if (hasConstructionInsulationQueryForContext) {
    formattedContext += '\n\n## Шаблон короткого ответа по общестрою\n'
    formattedContext += [
      'Рекомендация: <материал из 1С> — код <код 1С>.',
      'Альтернатива: <материал> — код <код 1С>, если есть.',
      'Сопутствующие: <мембрана/крепеж/другое> — код <код 1С или "код проверить">.',
      'Уточнить: <1-2 вопроса, только если без них нельзя выставить счет>.',
      'Почему: <одно короткое предложение>.',
      'Не использовать как основной вариант материалы без кода 1С, даже если они технически подходят.',
    ].map(line => `- ${line}`).join('\n')
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

  const shortInvoiceItems = strictInvoiceMode
    ? requested_invoice_items
    : requested_invoice_items.length > 0
    ? requested_invoice_items
    : relevant_nomenclature
  const foundInvoiceLines = requested_invoice_lines.filter((line) => line.found_item)
  const invoiceStatusLines = strictInvoiceMode
    ? [
        '',
        '## Строгая проверка строк счета',
        `- Найдено точных строк: ${foundInvoiceLines.length} из ${requested_invoice_lines.length}.`,
        ...foundInvoiceLines.slice(0, 8).map((line) => {
          const item = line.found_item
          const qtyPart = line.quantity ? ` | ${line.quantity}${line.unit ? ` ${line.unit}` : ''}` : ''
          return `- Найдено: ${item?.name ?? line.line} (код 1С: ${item?.code ?? '-'} | article: ${line.article}${qtyPart})`
        }),
        ...missing_invoice_items.slice(0, 8).map((line) => {
          const qtyPart = line.quantity ? ` | ${line.quantity}${line.unit ? ` ${line.unit}` : ''}` : ''
          return `- Проверить: ${line.line} (точный код 1С не найден | expected_article: ${line.article}${qtyPart})`
        }),
        ...(missing_invoice_items.length > 0
          ? ['- Нельзя писать "все позиции найдены" и нельзя автоматически заменять на другой угол/покрытие/серию.']
          : []),
      ]
    : []
  const shouldUseCompactResponse = compactMode || hasConstructionInsulationQueryForContext || isBareThicknessOnly
  const compactFormattedContext = [
    '# Короткий контекст для ответа менеджеру',
    `**Запрос:** ${rawQuery}`,
    ...invoiceStatusLines,
    '',
    '## Основные позиции 1С',
    ...(shortInvoiceItems.length > 0
      ? shortInvoiceItems.slice(0, 8).map((n) => {
      const codePart = n.code ? `код 1С: ${n.code}` : 'код 1С: —'
      const articlePart = n.article ? ` | article: ${n.article}` : ''
      const categoryPart = n.product_category_type ? ` | группа: ${n.product_category_type}` : ''
      const parentPart = n.code_1c_parent ? ` | родитель 1С: ${n.code_1c_parent}` : ''
      return `- **${n.name ?? '—'}** (${codePart}${articlePart}${categoryPart}${parentPart})`
        })
      : ['- Точной позиции 1С в контексте нет. Основной вариант без кода не давать.']),
    ...(nomenclature_analogs.length > 0
      ? [
          '',
          '## Аналоги / запрошенный вариант',
          ...nomenclature_analogs.slice(0, 6).map((n) => {
            const codePart = n.code ? `код 1С: ${n.code}` : 'код 1С: —'
            const categoryPart = n.product_category_type ? ` | группа: ${n.product_category_type}` : ''
            return `- **${n.name ?? '—'}** (${codePart}${categoryPart})`
          }),
        ]
      : []),
    '',
    '## Сопутствующие',
    ...(strictInvoiceMode
      ? ['- В режиме проверки строк счета не добавлять сопутствующие/аналоги сверх запроса без отдельного согласования.']
      : nomenclature_accessories.length > 0
      ? nomenclature_accessories.slice(0, 6).map((n) => {
          const codePart = n.code ? `код 1С: ${n.code}` : 'код 1С: проверить'
          return `- **${n.name ?? '—'}** (${codePart})`
        })
      : ['- Проверить сопутствующие по проекту.']),
    '',
    '## Что уточнить',
    ...(selection_guidance.questions.length > 0
      ? selection_guidance.questions.slice(0, 3).map((q) => `- ${q}`)
      : ['- Уточнения не требуются для предварительной рекомендации.']),
    '',
    '## Правила ответа',
    '- Ответ 5-8 строк: рекомендация, код 1С, сопутствующие, уточнить, почему.',
    '- Основной вариант давать только с кодом 1С из этого контекста.',
    '- Позиции без кода 1С писать только как кандидат: код нужно проверить.',
    '- Не писать "в наличии", если нет подтвержденного остатка.',
    ...(hasConstructionInsulationQueryForContext
      ? [
          ...(hasRoofWoolQueryForContext
            ? [
                '- ТЕХНОРУФ/РУФ = плоская кровля, не вентфасад; РУФ Н нижний слой, РУФ В верхний слой.',
                '- Для замены ТЕХНОРУФ предлагать BASWOOL РУФ первым с кодом 1С; исходный ТЕХНОРУФ только отдельным вариантом, если он есть в analogs.',
              ]
            : []),
          '- По минвате первым BASWOOL, вторым ROCKWOOL; ТЕХНОНИКОЛЬ по минвате не ставить первым.',
          '- Для вентфасада проверить мембрану и фасадный крепеж; Силму не ставить основным вариантом.',
        ]
      : [
          '- XOTPIPE без покрытия + оцинкованная окожушка O-ME-ZN допустимо.',
          '- Запрет "фольга + оцинковка" относится только к Alu/Alu1/фольгированным цилиндрам с отдельной оцинковкой.',
        ]),
  ].join('\n')
  const responseFormattedContext = shouldUseCompactResponse ? compactFormattedContext : formattedContext
  const strictCodeRule = {
    rule_name: 'Глобально — коды 1С только из JSON-контекста',
    rule_text: [
      'Запрещено придумывать коды 1С.',
      'Код 1С можно писать только если он явно пришел из JSON-полей инструмента: main_items, requested_invoice_items, invoice_lines.item, accessories или analogs.',
      'Если нужного кода нет в этих полях, писать: "точный код 1С не найден в контексте, нужно проверить номенклатуру".',
      'Не брать коды из памяти модели, старых переписок, примеров, описаний или предположений.',
    ].join(' '),
    is_prohibition: true,
  }
  const dbStrictCodeRule = applicable_rules.find((rule) =>
    /коды?\s+1[сc]\s+только|код\s+1[сc]\s+только|json-контекст|json контекст/i.test(
      `${rule.rule_name || ''} ${rule.rule_text || ''}`
    )
  )
  const strictRuleForTool = dbStrictCodeRule ?? strictCodeRule
  const compactRules = [
    strictRuleForTool,
    ...applicable_rules
      .filter((rule) => rule.id !== dbStrictCodeRule?.id && rule.rule_name !== strictRuleForTool.rule_name)
      .slice(0, 5),
  ]
  const compactChunks = shouldUseCompactResponse ? [] : chunks
  const mainItemsForTool = strictInvoiceMode ? requested_invoice_items : relevant_nomenclature
  const accessoriesForTool = strictInvoiceMode ? [] : nomenclature_accessories

  if (toolResponseMode) {
    return NextResponse.json({
      context: responseFormattedContext,
      main_items: mainItemsForTool.slice(0, 8).map((item) => ({
        code: item.code,
        article: item.article,
        name: item.name,
        brand: item.brand,
        category_type: item.product_category_type,
        parent_code: item.code_1c_parent,
        revenue_3y: item.revenue_3y,
        qty_3y: item.qty_3y,
      })),
      invoice_lines: requested_invoice_lines.slice(0, 12).map((line) => ({
        line: line.line,
        article: line.article,
        quantity: line.quantity,
        unit: line.unit,
        status: line.found_item ? 'found' : 'missing',
        item: line.found_item
          ? {
              code: line.found_item.code,
              article: line.found_item.article,
              name: line.found_item.name,
              brand: line.found_item.brand,
              category_type: line.found_item.product_category_type,
              parent_code: line.found_item.code_1c_parent,
            }
          : null,
      })),
      missing_items: missing_invoice_items.slice(0, 12).map((line) => ({
        line: line.line,
        expected_article: line.article,
        quantity: line.quantity,
        unit: line.unit,
        reason: 'exact_article_not_found',
      })),
      requested_invoice_items: requested_invoice_items.slice(0, 8).map((item) => ({
        code: item.code,
        article: item.article,
        name: item.name,
        brand: item.brand,
        category_type: item.product_category_type,
        parent_code: item.code_1c_parent,
      })),
      accessories: accessoriesForTool.slice(0, 6).map((item) => ({
        code: item.code,
        article: item.article,
        name: item.name,
        brand: item.brand,
        category_type: item.product_category_type,
        parent_code: item.code_1c_parent,
      })),
      analogs: nomenclature_analogs.slice(0, 6).map((item) => ({
        code: item.code,
        article: item.article,
        name: item.name,
        brand: item.brand,
        category_type: item.product_category_type,
        parent_code: item.code_1c_parent,
        revenue_3y: item.revenue_3y,
        qty_3y: item.qty_3y,
      })),
      questions: selection_guidance.questions.slice(0, 3),
      rules: compactRules.map((rule) => ({
        name: rule.rule_name,
        text: rule.rule_text,
        prohibition: rule.is_prohibition,
      })),
      meta: {
        compact: shouldUseCompactResponse,
        products_count: products.length,
        nomenclature_count: relevant_nomenclature.length,
        accessories_count: nomenclature_accessories.length,
        strict_invoice: strictInvoiceMode,
        invoice_lines_count: requested_invoice_lines.length,
        missing_items_count: missing_invoice_items.length,
        rules_count: compactRules.length,
        chunks_count: compactChunks.length,
      },
    })
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
    invoice_lines: requested_invoice_lines,
    missing_items: missing_invoice_items.map((line) => ({
      line: line.line,
      expected_article: line.article,
      quantity: line.quantity,
      unit: line.unit,
      reason: 'exact_article_not_found',
    })),
    requested_invoice_items,
    selection_guidance,
    applicable_rules: shouldUseCompactResponse ? compactRules : applicable_rules,
    relevant_notes: notes,
    document_chunks: compactChunks,
    formatted_context: responseFormattedContext,
    meta: {
      products_count: products.length,
      nomenclature_count: relevant_nomenclature.length,
      nomenclature_analogs_count: nomenclature_analogs.length,
      nomenclature_accessories_count: nomenclature_accessories.length,
      requested_invoice_items_count: requested_invoice_items.length,
      strict_invoice: strictInvoiceMode,
      invoice_lines_count: requested_invoice_lines.length,
      missing_items_count: missing_invoice_items.length,
      clarification_needed: selection_guidance.clarification_needed,
      rules_count:    applicable_rules.length,
      notes_count:    notes.length,
      chunks_count:   chunks.length,
      brand_priority: BRAND_PRIORITY,
      requested_size_numbers: requestedSizeNumbers,
      compact: shouldUseCompactResponse,
      requested_compact: compactMode,
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

  if (requestedInvoiceItems.length) {
    lines.push('## ПРИОРИТЕТ ДЛЯ СЧЕТА: точные строки запроса найдены в 1С')
    lines.push('Эти позиции уже найдены по артикулам/кодам. Не писать по ним "нет в базе" и не заменять их аналогами без запроса менеджера.')
    lines.push('Важно: XOTPIPE без покрытия + оцинкованная окожушка O-ME-ZN допустимо. Запрет "фольга + оцинковка" относится только к Alu/Alu1/фольгированным цилиндрам с отдельной оцинковкой.')
    for (const n of requestedInvoiceItems) {
      const codePart = n.code ? `код 1С: ${n.code}` : 'код 1С: —'
      const articlePart = n.article ? ` | article: ${n.article}` : ''
      lines.push(`- **${n.name ?? '—'}** (${codePart}${articlePart})`)
    }
    lines.push('')
  }

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
