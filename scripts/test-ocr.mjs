import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Get one document - any document with a file_url
const { data: docs, error } = await supabase
  .from('documents')
  .select('id, title, file_url, extracted_text')
  .not('file_url', 'is', null)
  .limit(5)

console.log('Error:', error)
console.log('Found docs:', docs?.length)
docs?.forEach((d) => console.log(`- ${d.title}: extracted=${!!d.extracted_text}`))

// Pick first doc
const doc = docs?.[0]
if (!doc) {
  console.log('No docs found')
  process.exit(1)
}

console.log('\nTesting OCR on:', doc.title)
console.log('URL:', doc.file_url)

// Call the extract endpoint
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL
const r = await fetch(`${SITE_URL}/api/documents/extract`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ document_id: doc.id, file_url: doc.file_url }),
})
const result = await r.json()
console.log('Result:', JSON.stringify(result, null, 2))
