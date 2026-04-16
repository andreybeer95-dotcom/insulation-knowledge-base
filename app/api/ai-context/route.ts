import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const query = searchParams.get('query') || searchParams.get('q') || ''
  const limitChunks = Math.min(parseInt(searchParams.get('limit_chunks') || '5'), 10)

  const supabase = createClient()

  const [productsRes, rulesRes, notesRes, chunksRes] = await Promise.allSettled([

    supabase
      .from('products')
      .select('id, name, coating, flammability, temp_max, diameter_min, diameter_max, manufacturer_id')
      .limit(20),

    supabase
      .from('selection_rules')
      .select('id, title, condition, recommendation, priority')
      .limit(10),

    supabase
      .from('knowledge_notes')
      .select('id, title, content, category')
      .limit(8),

    (async () => {
      if (!query || query.length < 2) return { data: [], error: null }

      const ftsQuery = query
        .trim()
        .split(/\s+/)
        .filter(w => w.length >= 2)
        .map(w => w + ':*')
        .join(' & ')

      if (!ftsQuery) return { data: [], error: null }

      const { data: rpcData, error: rpcError } = await supabase.rpc(
        'search_chunks_ranked',
        { search_query: ftsQuery, result_limit: limitChunks * 3 }
      )

      if (!rpcError && rpcData?.length) return { data: rpcData, error: null }

      const { data: ftsData, error: ftsError } = await supabase
        .from('document_chunks')
        .select('id, content, chunk_index, document_id, documents(id, title, manufacturers(name_ru))')
        .textSearch('content', ftsQuery, { type: 'websearch', config: 'russian' })
        .limit(limitChunks * 3)

      if (!ftsError && ftsData?.length) return { data: ftsData, error: null }

      const { data: ilikeData } = await supabase
        .from('document_chunks')
        .select('id, content, chunk_index, document_id, documents(id, title, manufacturers(name_ru))')
        .ilike('content', `%${query}%`)
        .limit(limitChunks * 3)

      return { data: ilikeData || [], error: null }
    })(),
  ])

  const products = productsRes.status === 'fulfilled' ? (productsRes.value.data || []) : []
  const rules    = rulesRes.status === 'fulfilled'    ? (rulesRes.value.data || [])    : []
  const notes    = notesRes.status === 'fulfilled'    ? (notesRes.value.data || [])    : []
  const rawChunks = chunksRes.status === 'fulfilled'  ? ((chunksRes.value as any).data || []) : []

  const chunks = deduplicateChunks(rawChunks, limitChunks)

  const formattedContext = buildContext(query, products, rules, notes, chunks)

  return NextResponse.json({
    query,
    detected: detectContext(query),
    relevant_products: products,
    applicable_rules: rules,
    relevant_notes: notes,
    document_chunks: chunks,
    formatted_context: formattedContext,
    meta: {
      products_count: products.length,
      rules_count: rules.length,
      notes_count: notes.length,
      chunks_count: chunks.length,
    },
  })
}

function detectContext(query: string) {
  const manufacturers = ['rockwool', 'isover', 'knauf', 'технониколь', 'paroc', 'ursa']
    .filter(m => query.toLowerCase().includes(m))
  const du_values = (query.match(/\b(\d{2,3})\b/g) || []).map(Number)
  return { manufacturers, du_values, keywords: [] }
}

function deduplicateChunks(chunks: any[], limit: number): any[] {
  const seenDocs = new Map<string, number>()
  const seenContent = new Set<string>()
  const result: any[] = []

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

function buildContext(query: string, products: any[], rules: any[], notes: any[], chunks: any[]): string {
  const lines: string[] = [`# База знаний — контекст\n**Запрос:** ${query}\n`]

  if (chunks.length) {
    lines.push('## Из технической документации (PDF)')
    for (const c of chunks) {
      const doc = c.documents
      const title = doc?.title || 'Документ'
      const mfr = doc?.manufacturers?.name_ru
      lines.push(`### ${title}${mfr ? ` (${mfr})` : ''}`)
      lines.push(makeSnippet(c.content, query))
      lines.push('')
    }
  }

  if (products.length) {
    lines.push('## Продукты')
    for (const p of products) {
      lines.push(`- **${p.name}** | ${p.flammability} | T до ${p.temp_max}°C | ДУ ${p.diameter_min}–${p.diameter_max}`)
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

function makeSnippet(text: string, query: string, ctx = 200): string {
  const words = query.toLowerCase().split(/\s+/).filter(w => w.length >= 2)
  let bestIdx = -1
  for (const w of words) {
    const idx = text.toLowerCase().indexOf(w)
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx
  }
  if (bestIdx === -1) return text.slice(0, ctx * 2).trim() + '...'
  const start = Math.max(0, bestIdx - ctx)
  const end = Math.min(text.length, bestIdx + ctx)
  return (start > 0 ? '...' : '') + text.slice(start, end).trim() + (end < text.length ? '...' : '')
}
