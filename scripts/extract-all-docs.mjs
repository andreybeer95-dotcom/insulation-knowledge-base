import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || 'https://insulation-knowledge-base-production.up.railway.app'

// Get docs without extracted text
const { data: docs } = await supabase
  .from('documents')
  .select('id, title, file_url')
  .not('file_url', 'is', null)
  .is('extracted_text', null)
  .limit(100)

const docRows = docs ?? []
console.log('Docs without extracted text:', docRows.length)

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
