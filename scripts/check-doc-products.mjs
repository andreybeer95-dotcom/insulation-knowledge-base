import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Count documents with and without product links
const { data: docs, error: e1 } = await supabase
  .from('documents')
  .select('id, title, manufacturer_id, extracted_text')
  .limit(1000)

console.log('docs error:', e1)
console.log('docs count:', docs?.length)

const { data: docProducts, error: e2 } = await supabase
  .from('document_products')
  .select('document_id')
  .limit(10000)

console.log('docProducts error:', e2)
console.log('docProducts count:', docProducts?.length)

const linkedDocs = new Set(docProducts?.map((dp) => dp.document_id))

console.log('Total documents:', docs?.length)
console.log(
  'Documents with product links:',
  docs?.filter((d) => linkedDocs.has(d.id))?.length ?? 0
)
console.log(
  'Documents WITHOUT product links:',
  docs?.filter((d) => !linkedDocs.has(d.id))?.length ?? 0
)
console.log(
  'Documents with extracted text:',
  docs?.filter((d) => d.extracted_text)?.length ?? 0
)

// Show sample unlinked doc
const unlinked = docs?.find((d) => !linkedDocs.has(d.id))
console.log('\nSample unlinked doc:', unlinked?.title)
console.log('manufacturer_id:', unlinked?.manufacturer_id)
