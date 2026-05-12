import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://insulation-knowledge-base-production.up.railway.app'

const CHUNK_SIZE = 1000
const CHUNK_OVERLAP = 200

function splitIntoChunks(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    const end = Math.min(start + size, text.length)
    chunks.push(text.slice(start, end))
    start += size - overlap
    if (start >= text.length) break
  }
  return chunks
}

// Get all docs with extracted_text (paginate past PostgREST default cap)
const docRows = []
const pageSize = 1000
for (let from = 0; ; from += pageSize) {
  const { data: page, error } = await supabase
    .from('documents')
    .select('id, title, extracted_text, manufacturer_id')
    .not('extracted_text', 'is', null)
    .gt('extracted_text', '')
    .range(from, from + pageSize - 1)

  if (error) {
    console.error('documents query error:', error.message)
    process.exit(1)
  }
  if (!page?.length) break
  docRows.push(...page)
  if (page.length < pageSize) break
}

console.log('Docs with text:', docRows.length)

// Count existing chunks per document (paginate — unbounded select is capped)
const chunkCounts = {}
for (let from = 0; ; from += pageSize) {
  const { data: page, error } = await supabase
    .from('document_chunks')
    .select('document_id')
    .range(from, from + pageSize - 1)

  if (error) {
    console.error('document_chunks query error:', error.message)
    process.exit(1)
  }
  if (!page?.length) break
  for (const c of page) {
    chunkCounts[c.document_id] = (chunkCounts[c.document_id] || 0) + 1
  }
  if (page.length < pageSize) break
}

// Find docs without chunks or with very few
const needsChunking = docRows.filter((d) => !chunkCounts[d.id] || chunkCounts[d.id] < 2)
console.log('Docs needing chunks:', needsChunking.length)

let processed = 0
let totalChunks = 0

for (const doc of needsChunking) {
  if (!doc.extracted_text || doc.extracted_text.length < 50) continue

  await supabase.from('document_chunks').delete().eq('document_id', doc.id)

  const chunks = splitIntoChunks(doc.extracted_text)
  const chunkRows = chunks.map((content, i) => ({
    document_id: doc.id,
    chunk_index: i,
    content,
    metadata: { total_chunks: chunks.length, source: 'rechunk-all-docs' },
  }))

  if (chunkRows.length > 0) {
    const { error } = await supabase.from('document_chunks').insert(chunkRows)
    if (error) {
      console.error(`❌ ${doc.title}: ${error.message}`)
    } else {
      processed++
      totalChunks += chunkRows.length
      if (processed % 50 === 0) {
        console.log(`Progress: ${processed}/${needsChunking.length}, chunks: ${totalChunks}`)
      }
    }
  }
}

console.log(`\nDone! Processed: ${processed} docs, created: ${totalChunks} chunks`)
