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
    'cutwool': '6bc4d830-ca68-4a3e-8dbf-570a220f14ea',
    'isotec': '96cd9ebc-b30c-4544-930e-1f375745fa48',
  };

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

  // ─── параллельные запросы ─────────────────────────────────
  const [productsRes, rulesRes, notesRes, chunksRes] = await Promise.allSettled([

    // продукты — теперь тянем из новой схемы с атрибутами
    supabase
      .from('products')
      .select(`
        id, kod_1c, name, coating, flammability,
        temp_max, temp_min, diameter_min, diameter_max,
        density, thickness, in_stock,
        manufacturer_id, manufacturers(name_ru),
        category_id, categories(name, full_path)
      `)
      .eq(product_id ? 'id' : 'in_stock', product_id ?? true)
      .limit(20),

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

  const products  = productsRes.status === 'fulfilled' ? (productsRes.value.data ?? []) : []
  const rules     = rulesRes.status    === 'fulfilled' ? (rulesRes.value.data    ?? []) : []
  const notes     = notesRes.status    === 'fulfilled' ? (notesRes.value.data    ?? []) : []
  const rawChunks = chunksRes.status   === 'fulfilled' ? chunksRes.value          : []

  const chunks = deduplicateChunks(rawChunks, limitChunks)
  const { data: rulesData } = await supabase
    .from('selection_rules')
    .select('id, rule_name, condition, rule_text, priority, is_prohibition')
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

  // Если релевантных нет — берём все запреты (они всегда важны)
  const applicable_rules = relevantRules.length > 0
    ? relevantRules
    : allRules.filter(r => r.is_prohibition);

  let formattedContext = buildContext(query, products, rules, notes, chunks)
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
    detected: detectContext(query),
    relevant_products: products,
    applicable_rules,
    relevant_notes: notes,
    document_chunks: chunks,
    formatted_context: formattedContext,
    meta: {
      products_count: products.length,
      rules_count:    applicable_rules.length,
      notes_count:    notes.length,
      chunks_count:   chunks.length,
    },
  })
}

// ─── поиск чанков: новая RPC → старая RPC → FTS → ILIKE ──────
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
  chunks: ChunkRow[]
): string {
  const lines: string[] = [`# База знаний — контекст\n**Запрос:** ${query}\n`]

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
