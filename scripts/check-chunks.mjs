import { createClient } from '@supabase/supabase-js'

const s = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const r = await s.from('document_chunks').select('*', { count: 'exact', head: true })
console.log('Total chunks:', r.count)

const r2 = await s.from('documents').select('*', { count: 'exact', head: true })
console.log('Total docs:', r2.count)

const r3 = await s
  .from('documents')
  .select('*', { count: 'exact', head: true })
  .not('extracted_text', 'is', null)
console.log('Docs with extracted text:', r3.count)
