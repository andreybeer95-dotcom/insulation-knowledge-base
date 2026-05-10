import { createClient } from '@supabase/supabase-js'
import fs from 'fs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://insulation-knowledge-base-production.up.railway.app'

const BRANDS = [
  { name: 'ROCKWOOL', manufacturer_id: '6f22e435-08cc-46ab-ba45-d119ce497581', site: 'rwl.ru' },
  { name: 'ИЗОСПАН', name_ru: 'ИЗОСПАН', site: 'ispan.ru' },
  { name: 'ОНДУТИС', name_ru: 'ОНДУТИС', site: 'ondutis.ru' },
  { name: 'ПЕНЕТРОН', manufacturer_id: '2687b7ce-c178-4f81-a6c1-355fd82e6e08', site: 'penetron.ru' },
  { name: 'ИМПЕР', manufacturer_id: 'f03dbf70-77b2-464b-892d-ba9ec14af826', site: 'tn.ru' },
  { name: 'ЭНЕРГОФЛЕКС', manufacturer_id: '4d0e322c-9a32-41e1-9cfb-8b84161a6319', site: 'rols-isomarket.ru' },
  { name: 'URSA', manufacturer_id: 'c281f409-592e-4404-abc0-9144cc046941', site: 'ursa.ru' },
  { name: 'ТЕРМАФЛЕКС', name_ru: 'ТЕРМАФЛЕКС', site: 'thermaflex.ru' },
  { name: 'КАЛКАН', manufacturer_id: '8475938d-ad24-4c0b-8036-a09cbb82b36a', site: 'kalkan-insulation.ru' },
  { name: 'BASWOOL', manufacturer_id: 'c0f1731c-12a2-4d6a-bca3-6020711de7f5', site: 'baswool.ru' },
  { name: 'ЗВУКОИЗОЛ', manufacturer_id: '704afeef-945d-4f26-b003-8e8c9047b6b0', site: 'zvukoizol.ru' },
]

function detectDocType(title) {
  const t = (title || '').toLowerCase()
  if (t.includes('сертификат') || t.includes('декларац') || t.includes('гигиен') || t.includes('пожарн')) return 'сертификат'
  if (t.includes('инструкц') || t.includes('монтаж') || t.includes('руководств')) return 'инструкция'
  if (t.includes('прайс')) return 'прайс'
  if (t.includes('каталог') || t.includes('брошюр')) return 'дополнение'
  return 'техлист'
}

async function findDocs(brand) {
  console.log(`\n📁 ${brand.name}`)

  const response = await fetch(`${SITE_URL}/api/find-docs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal-secret': process.env.INTERNAL_API_SECRET || '',
    },
    body: JSON.stringify({ brand: brand.name, site: brand.site }),
  })

  const data = await response.json()

  if (data.raw) console.log(`  AI: ${String(data.raw).substring(0, 300)}`)
  if (data.error) console.log(`  ❌ Ошибка API: ${data.error}`)

  const pdfs = data.pdfs || []
  console.log(`  Найдено: ${pdfs.length} документов`)

  fs.writeFileSync(`scripts/found-docs-${brand.name}.json`, JSON.stringify(pdfs, null, 2))
  return pdfs
}

async function saveToDB(pdfs, brand) {
  let mfrId = brand.manufacturer_id
  if (!mfrId && brand.name_ru) {
    const { data } = await supabase
      .from('manufacturers')
      .select('id')
      .ilike('name_ru', brand.name_ru)
      .maybeSingle()
    mfrId = data?.id ?? null
  }

  let saved = 0
  for (const pdf of pdfs) {
    if (!pdf.url || !String(pdf.url).toLowerCase().includes('.pdf')) continue
    const { data } = await supabase.from('documents').select('id').eq('source_url', pdf.url).maybeSingle()
    if (data) continue

    const fileName = String(pdf.url).split('/').pop() || 'document.pdf'
    const { error } = await supabase.from('documents').insert({
      title: pdf.title || fileName,
      manufacturer_id: mfrId,
      source_url: pdf.url,
      file_url: pdf.url,
      file_name: fileName,
      doc_type: detectDocType(pdf.title),
      uploaded_by: 'ai-scraper',
    })
    if (!error) {
      saved++
      console.log(`  ✅ ${pdf.title || fileName}`)
    } else {
      console.error(`  ❌ DB: ${error.message}`)
    }
  }
  if (saved > 0) console.log(`  Сохранено: ${saved}`)
}

async function main() {
  for (const brand of BRANDS) {
    const pdfs = await findDocs(brand)
    if (pdfs.length > 0) await saveToDB(pdfs, brand)
  }
  console.log('\n✅ Готово!')
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
