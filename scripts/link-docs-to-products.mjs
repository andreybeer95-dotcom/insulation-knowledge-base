import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Get all documents with manufacturer_id
const { data: docs } = await supabase
  .from('documents')
  .select('id, manufacturer_id, title')
  .not('manufacturer_id', 'is', null)

const docRows = docs ?? []
console.log('Total docs with manufacturer:', docRows.length)

// Get existing links to avoid duplicates
const { data: existing } = await supabase
  .from('document_products')
  .select('document_id, product_id')

const existingSet = new Set(
  (existing ?? []).map((e) => `${e.document_id}:${e.product_id}`)
)

let totalLinked = 0

// Process each manufacturer
const mfrIds = [...new Set(docRows.map((d) => d.manufacturer_id))]
console.log('Manufacturers to process:', mfrIds.length)

for (const mfrId of mfrIds) {
  const mfrDocs = docRows.filter((d) => d.manufacturer_id === mfrId)

  // Get products for this manufacturer
  const { data: products } = await supabase
    .from('products')
    .select('id')
    .eq('manufacturer_id', mfrId)
    .eq('in_stock', true)
    .limit(100)

  if (!products?.length) continue

  console.log(`Manufacturer ${mfrId}: ${mfrDocs.length} docs, ${products.length} products`)

  // Create links
  const links = []
  for (const doc of mfrDocs) {
    for (const product of products) {
      const key = `${doc.id}:${product.id}`
      if (!existingSet.has(key)) {
        links.push({ document_id: doc.id, product_id: product.id })
        existingSet.add(key)
      }
    }
  }

  if (links.length > 0) {
    // Insert in batches of 500
    for (let i = 0; i < links.length; i += 500) {
      const batch = links.slice(i, i + 500)
      const { error } = await supabase.from('document_products').insert(batch)
      if (error) console.error('Error:', error.message)
      else totalLinked += batch.length
    }
    console.log(`  ✅ Linked ${links.length} doc-product pairs`)
  }
}

console.log(`\nTotal new links created: ${totalLinked}`)
