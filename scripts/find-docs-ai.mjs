import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import fs from 'fs'

const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://insulation-knowledge-base-production.up.railway.app'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const BRANDS = [
  { name: 'ROCKWOOL', manufacturer_id: '6f22e435-08cc-46ab-ba45-d119ce497581', site: 'rwl.ru' },
  { name: 'ИЗОСПАН', name_ru: 'ИЗОСПАН', site: 'ispan.ru' },
  { name: 'ОНДУТИС', name_ru: 'ОНДУТИС', site: 'ondutis.ru' },
  { name: 'ПЕНЕТРОН', manufacturer_id: '2687b7ce-c178-4f81-a6c1-355fd82e6e08', site: 'penetron.ru' },
  { name: 'ИМПЕР', manufacturer_id: 'f03dbf70-77b2-464b-892d-ba9ec14af826', site: 'tn.ru' },
  { name: 'КАЛКАН', manufacturer_id: '8475938d-ad24-4c0b-8036-a09cbb82b36a', site: 'kalkan-insulation.ru' },
  { name: 'ЭНЕРГОФЛЕКС', manufacturer_id: '4d0e322c-9a32-41e1-9cfb-8b84161a6319', site: 'rols-isomarket.ru' },
]

async function callAI(screenshot, site) {
  const response = await fetch(`${SITE_URL}/api/find-docs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      screenshot: screenshot.toString('base64'),
      site,
    }),
  })
  if (!response.ok) {
    const t = await response.text()
    throw new Error(`find-docs API ${response.status}: ${t.slice(0, 800)}`)
  }
  const data = await response.json()
  return data.pdfs || []
}

async function findDocsWithAI(browser, brand) {
  console.log(`\n📁 ${brand.name}`)
  const page = await browser.newPage()

  try {
    const urls = [
      `https://${brand.site}/dokumenty/`,
      `https://${brand.site}/documentation/`,
      `https://${brand.site}/library/`,
      `https://${brand.site}/`,
    ]

    let screenshot = null
    let pageUrl = null

    for (const url of urls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
        await page.waitForTimeout(2000)
        screenshot = await page.screenshot({ fullPage: false, type: 'png' })
        pageUrl = url
        console.log(`  Открыли: ${url}`)
        break
      } catch {}
    }

    if (!screenshot) {
      console.log(`  ❌ Сайт недоступен`)
      return []
    }

    const pdfs = await callAI(screenshot, brand.site)
    if (!Array.isArray(pdfs)) {
      console.log(`  AI вернул не массив`)
      return []
    }
    console.log(`  Найдено AI: ${pdfs.length} документов (${pageUrl})`)
    return pdfs
  } catch (e) {
    console.error(`  ❌ ${e.message}`)
    return []
  } finally {
    await page.close()
  }
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

  function detectDocType(title) {
    const t = (title || '').toLowerCase()
    if (t.includes('сертификат') || t.includes('декларац') || t.includes('гигиен') || t.includes('пожарн')) return 'сертификат'
    if (t.includes('инструкц') || t.includes('монтаж') || t.includes('руководств')) return 'инструкция'
    if (t.includes('прайс')) return 'прайс'
    if (t.includes('каталог') || t.includes('брошюр')) return 'дополнение'
    return 'техлист'
  }

  let saved = 0
  for (const pdf of pdfs) {
    if (!pdf.url || !String(pdf.url).toLowerCase().includes('.pdf')) continue
    const { data } = await supabase.from('documents').select('id').eq('source_url', pdf.url).maybeSingle()
    if (data) continue

    const fileName = String(pdf.url).split('/').pop() || 'document.pdf'
    const title = pdf.title || fileName

    const { error } = await supabase.from('documents').insert({
      title,
      manufacturer_id: mfrId,
      source_url: pdf.url,
      file_url: pdf.url,
      file_name: fileName,
      doc_type: detectDocType(pdf.title),
      uploaded_by: 'ai-scraper',
    })
    if (error) {
      console.error(`  ❌ INSERT: ${error.message}`)
    } else {
      saved++
      console.log(`  ✅ ${title}`)
    }
  }
  console.log(`  Сохранено: ${saved}`)
}

async function main() {
  const browser = await chromium.launch({ headless: true })

  for (const brand of BRANDS) {
    const pdfs = await findDocsWithAI(browser, brand)
    fs.writeFileSync(
      `scripts/found-docs-ai-${brand.name}.json`,
      JSON.stringify(pdfs, null, 2),
      'utf-8'
    )
    if (pdfs.length > 0) await saveToDB(pdfs, brand)
  }

  await browser.close()
  console.log('\n✅ Готово!')
}

main()
