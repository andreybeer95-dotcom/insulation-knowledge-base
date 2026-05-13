import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://insulation-knowledge-base-production.up.railway.app'

const REEXTRACT_SHORT = process.env.REEXTRACT_SHORT === 'true'

let docRows = []

if (REEXTRACT_SHORT) {
  console.log('Mode: REEXTRACT_SHORT — file_url set and (extracted_text IS NULL OR length < 100)')
  const cap = 1000

  const { data: nullDocs, error: e1 } = await supabase
    .from('documents')
    .select('id, title, file_url')
    .not('file_url', 'is', null)
    .is('extracted_text', null)
    .limit(cap)

  if (e1) {
    console.error('documents query (null text) error:', e1.message)
    process.exit(1)
  }

  const nullList = nullDocs ?? []
  const remaining = Math.max(0, cap - nullList.length)
  let shortList = []

  if (remaining > 0) {
    const { data: candidates, error: e2 } = await supabase
      .from('documents')
      .select('id, title, file_url, extracted_text')
      .not('file_url', 'is', null)
      .not('extracted_text', 'is', null)
      .order('created_at', { ascending: true })
      .limit(8000)

    if (e2) {
      console.error('documents query (non-null text) error:', e2.message)
      process.exit(1)
    }

    shortList = (candidates ?? [])
      .filter((d) => String(d.extracted_text ?? '').length < 100)
      .slice(0, remaining)
      .map(({ id, title, file_url }) => ({ id, title, file_url }))
  }

  const seen = new Set(nullList.map((d) => d.id))
  docRows = [...nullList]
  for (const d of shortList) {
    if (!seen.has(d.id)) {
      seen.add(d.id)
      docRows.push(d)
    }
  }
} else {
  const { data: docs, error } = await supabase
    .from('documents')
    .select('id, title, file_url')
    .not('file_url', 'is', null)
    .is('extracted_text', null)
    .limit(1000)

  if (error) {
    console.error('documents query error:', error.message)
    process.exit(1)
  }

  docRows = docs ?? []
}

console.log(REEXTRACT_SHORT ? 'Docs to extract (null or short text):' : 'Docs without extracted text:', docRows.length)

let success = 0
let failed = 0

for (const doc of docRows) {
  try {
    const r = await fetch(`${SITE_URL}/api/documents/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ document_id: doc.id, file_url: doc.file_url }),
    })
    const text = await r.text()
    let result
    try {
      result = JSON.parse(text)
    } catch {
      failed++
      console.log(`❌ ${doc.title}: HTTP ${r.status} (non-JSON body)`)
      continue
    }
    if (result.ok) {
      success++
      console.log(`✅ ${doc.title} (${result.chars} chars)`)
    } else {
      failed++
      console.log(`❌ ${doc.title}: ${result.error}`)
    }
  } catch (e) {
    failed++
    console.log(`❌ ${doc.title}: ${e.message}`)
  }
  await new Promise((r) => setTimeout(r, 500))
}

console.log(`\nДобавлено: ${success}, ошибок: ${failed}`)
