import { createClient } from '@supabase/supabase-js'
import fetch from 'node-fetch'
import * as cheerio from 'cheerio'
import fs from 'fs'
import path from 'path'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

// Список сайтов производителей для сбора PDF
const SOURCES = [
  {
    brand: 'ИМПЕР',
    manufacturer_id: 'f03dbf70-77b2-464b-892d-ba9ec14af826',
    urls: [
      'https://www.tn.ru/resources/imper/catalog/',
    ],
    pdf_selector: 'a[href$=".pdf"]',
  },
  {
    brand: 'URSA',
    manufacturer_id: 'c281f409-592e-4404-abc0-9144cc046941',
    urls: [
      'https://www.ursa.ru/ru-ru/professionals/technical-documentation/',
    ],
    pdf_selector: 'a[href$=".pdf"]',
  },
  {
    brand: 'КАЛКАН',
    manufacturer_id: '8475938d-ad24-4c0b-8036-a09cbb82b36a',
    urls: [
      'https://kalkan-insulation.ru/dokumenty/',
    ],
    pdf_selector: 'a[href$=".pdf"]',
  },
  {
    brand: 'ENERGOFLEX',
    manufacturer_id: '4d0e322c-9a32-41e1-9cfb-8b84161a6319',
    urls: [
      'https://www.energoflex.ru/documentation/',
    ],
    pdf_selector: 'a[href$=".pdf"]',
  },
]

async function scrapePDFs(source) {
  console.log(`\nСканируем ${source.brand}...`)
  const found = []

  for (const url of source.urls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DocBot/1.0)' }
      })
      const html = await res.text()
      const $ = cheerio.load(html)

      $(source.pdf_selector).each((_, el) => {
        let href = $(el).attr('href')
        if (!href) return
        if (!href.startsWith('http')) {
          const base = new URL(url)
          href = new URL(href, base).toString()
        }
        const title = $(el).text().trim() || path.basename(href)
        found.push({ url: href, title, source_url: url })
      })

      console.log(`  ${url}: найдено ${found.length} PDF`)
    } catch (e) {
      console.error(`  Ошибка ${url}: ${e.message}`)
    }
  }

  return found
}

async function saveToSupabase(pdfs, source) {
  for (const pdf of pdfs) {
    const { data: existing } = await supabase
      .from('documents')
      .select('id')
      .eq('source_url', pdf.url)
      .single()

    if (existing) {
      console.log(`  Уже есть: ${pdf.title}`)
      continue
    }

    const { error } = await supabase.from('documents').insert({
      title: pdf.title,
      manufacturer_id: source.manufacturer_id,
      source_url: pdf.url,
      file_url: pdf.url,
      doc_type: 'technical',
      status: 'pending', // Нужна индексация
    })

    if (error) console.error(`  Ошибка сохранения: ${error.message}`)
    else console.log(`  ✅ Сохранено: ${pdf.title}`)
  }
}

async function main() {
  for (const source of SOURCES) {
    const pdfs = await scrapePDFs(source)
    console.log(`  Итого найдено: ${pdfs.length} PDF для ${source.brand}`)

    // Сохраняем список в JSON для проверки
    fs.writeFileSync(
      `scripts/found-docs-${source.brand.toLowerCase()}.json`,
      JSON.stringify(pdfs, null, 2)
    )

    if (pdfs.length > 0) {
      await saveToSupabase(pdfs, source)
    }
  }
  console.log('\nГотово!')
}

main()
