import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://insulation-knowledge-base-production.up.railway.app'
const SECRET = process.env.INTERNAL_API_SECRET || ''

async function findSiteViaDDG(brandName) {
  try {
    const response = await fetch(`${SITE_URL}/api/find-docs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-secret': SECRET,
      },
      body: JSON.stringify({
        brand: brandName,
        site: brandName.toLowerCase().replace(/\s+/g, ''),
        searchForSite: true,
      }),
    })
    const data = await response.json()
    if (!response.ok) {
      return ''
    }
    return typeof data.raw === 'string' ? data.raw : ''
  } catch {
    return ''
  }
}

const { data: manufacturers } = await supabase
  .from('manufacturers')
  .select('id, name_ru')
  .order('name_ru')

const { data: docs } = await supabase.from('documents').select('manufacturer_id')

const withDocs = new Set((docs ?? []).map((d) => d.manufacturer_id))
const withoutDocs = (manufacturers ?? []).filter((m) => !withDocs.has(m.id))

console.log(`Без документов: ${withoutDocs.length}\n`)

const results = []
for (const mfr of withoutDocs) {
  const raw = await findSiteViaDDG(mfr.name_ru)

  const match = raw.match(/https?:\/\/[^\s"'<>]+/)
  let site = null
  if (match) {
    try {
      site = new URL(match[0]).origin
    } catch {
      site = null
    }
  }

  results.push({ id: mfr.id, name: mfr.name_ru, site })
  console.log(`${site ? '✅' : '❌'} ${mfr.name_ru}: ${site || 'не найден'}`)

  await new Promise((r) => setTimeout(r, 500))
}

fs.writeFileSync('scripts/manufacturer-sites.json', JSON.stringify(results, null, 2))
console.log('\nГотово!')
