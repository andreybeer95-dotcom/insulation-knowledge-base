import { createClient } from '@supabase/supabase-js'
import { chromium } from 'playwright'
import fs from 'fs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const SOURCES = [
  {
    brand: 'URSA',
    manufacturer_id: 'c281f409-592e-4404-abc0-9144cc046941',
    doc_pages: [
      'https://ursa.ru/library/catalogs/brochures/',
      'https://ursa.ru/library/certificates/',
      'https://ursa.ru/library/technical-documentation/',
      'https://ursa.ru/library/catalogs/',
    ]
  },
  {
    brand: 'ROCKWOOL',
    manufacturer_id: '6f22e435-08cc-46ab-ba45-d119ce497581',
    custom_scraper: 'rockwool',
    doc_pages: [
      'https://rwl.ru/resources-and-tools/docs/',
    ]
  },
  {
    brand: 'ПЕНЕТРОН',
    manufacturer_id: '2687b7ce-c178-4f81-a6c1-355fd82e6e08',
    doc_pages: [
      'https://penetron.ru/about/documentation/',
      'https://penetron.ru/support/documents/',
    ]
  },
  {
    brand: 'ТЕРМАФЛЕКС',
    manufacturer_id: null,
    name_ru: 'ТЕРМАФЛЕКС',
    doc_pages: [
      'https://thermaflex.ru/products/',
      'https://thermaflex.ru/about/documents/',
    ]
  },
  {
    brand: 'ИЗОСПАН',
    manufacturer_id: null,
    name_ru: 'ИЗОСПАН',
    doc_pages: [
      'https://ispan.ru/dokumenty/',
      'https://ispan.ru/sertifikaty/',
    ]
  },
  {
    brand: 'ОНДУТИС',
    manufacturer_id: null,
    name_ru: 'ОНДУТИС',
    doc_pages: [
      'https://ondutis.ru/sertifikaty/',
      'https://ondutis.ru/dokumenty/',
    ]
  },
  {
    brand: 'ЭНЕРГОФЛЕКС',
    manufacturer_id: '4d0e322c-9a32-41e1-9cfb-8b84161a6319',
    doc_pages: [
      'https://rols-isomarket.ru/documentation/',
      'https://rols-isomarket.ru/catalog/',
    ]
  },
]

async function scrapePage(page, url) {
  console.log(`  Открываем: ${url}`)
  const pdfUrls = new Set()

  // Перехватываем сетевые запросы
  page.on('response', async (response) => {
    const responseUrl = response.url()
    if (responseUrl.toLowerCase().includes('.pdf')) {
      pdfUrls.add(responseUrl)
    }
  })

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
    await page.waitForTimeout(3000)

    // Скроллим для lazy loading
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight))
      await page.waitForTimeout(500)
    }

    // Собираем PDF ссылки из DOM
    const domPdfs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .filter(a => a.href.toLowerCase().includes('.pdf'))
        .map(a => ({ url: a.href, title: a.textContent.trim() || a.href.split('/').pop() }))
    })

    // Добавляем перехваченные URL
    const networkPdfs = Array.from(pdfUrls).map(u => ({
      url: u,
      title: u.split('/').pop()
    }))

    const all = [...domPdfs, ...networkPdfs]
    // Дедупликация
    const unique = Array.from(new Map(all.map(p => [p.url, p])).values())

    console.log(`  Найдено PDF: ${unique.length}`)
    return unique

  } catch (e) {
    console.error(`  ❌ ${e.message}`)
    return []
  }
}

// Специальная функция для rwl.ru - они используют AJAX API
async function scrapeRockwool(page) {
  console.log('  Используем API rwl.ru...')
  const pdfs = []

  // Перехватываем XHR/fetch запросы
  const apiResponses = []
  const onResponse = async (response) => {
    const url = response.url()
    if (url.includes('/docs/') || url.includes('document') || url.includes('api')) {
      try {
        const ct = response.headers()['content-type'] || ''
        if (ct.includes('json')) {
          const json = await response.json()
          apiResponses.push({ url, json })
        }
      } catch {}
    }
  }
  page.on('response', onResponse)

  try {
    await page.goto('https://rwl.ru/resources-and-tools/docs/?document_types[]=11&document_types[]=12&document_types[]=13&document_types[]=17', {
      waitUntil: 'networkidle', timeout: 30000
    })
    await page.waitForTimeout(5000)

    // Скроллим и кликаем "показать ещё" если есть
    try {
      const btn = await page.$('button:has-text("Показать ещё"), button:has-text("Загрузить"), .load-more')
      if (btn) { await btn.click(); await page.waitForTimeout(2000) }
    } catch {}

    // Собираем все ссылки с расширениями документов
    const links = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .filter(a => {
          const href = a.href.toLowerCase()
          return href.includes('.pdf') || href.includes('.doc') ||
               href.includes('download') || href.includes('upload')
        })
        .map(a => ({
          url: a.href,
          title: a.closest('[class*="doc"], [class*="card"], [class*="item"]')
            ?.querySelector('[class*="title"], [class*="name"], h3, h4')
            ?.textContent?.trim() || a.textContent.trim() || a.href.split('/').pop()
        }))
    })

    pdfs.push(...links)

    // Логируем API ответы для отладки
    if (apiResponses.length > 0) {
      console.log(`  API responses: ${apiResponses.length}`)
      fs.writeFileSync('scripts/rwl-api-debug.json', JSON.stringify(apiResponses, null, 2))
    }

    console.log(`  DOM ссылки: ${links.length}`)
    return links
  } finally {
    page.off('response', onResponse)
  }
}

async function saveToDB(pdfs, source) {
  function detectDocType(title) {
    const t = title.toLowerCase()
    if (t.includes('сертификат') || t.includes('декларац') || t.includes('гигиен') || t.includes('пожарн') || t.includes('соответств')) return 'сертификат'
    if (t.includes('инструкц') || t.includes('монтаж') || t.includes('руководств') || t.includes('правила')) return 'инструкция'
    if (t.includes('прайс') || t.includes('цен')) return 'прайс'
    if (t.includes('каталог') || t.includes('брошюр') || t.includes('альбом')) return 'дополнение'
    return 'техлист' // по умолчанию
  }

  console.log(`  Trying to save ${pdfs.length} PDFs for ${source.brand}`)
  let mfrId = source.manufacturer_id
  if (!mfrId && source.name_ru) {
    const { data: m } = await supabase
      .from('manufacturers')
      .select('id')
      .ilike('name_ru', source.name_ru)
      .maybeSingle()
    mfrId = m?.id ?? null
  }

  let saved = 0
  const withTimeout = (promise, ms = 5000) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('DB timeout')), ms))
    ])
  for (const pdf of pdfs) {
    let data = null
    try {
      const res = await withTimeout(
        supabase
          .from('documents')
          .select('id')
          .eq('source_url', pdf.url)
          .maybeSingle()
      )
      data = res.data
    } catch {
      continue
    }

    if (data) continue

    const fileName = pdf.url.split('/').pop() || 'document.pdf'
    const title = pdf.title || fileName.replace('.pdf', '')
    const docType = detectDocType(title)
    let error = null
    try {
      const res = await withTimeout(
        supabase.from('documents').insert({
          title,
          manufacturer_id: mfrId,
          source_url: pdf.url,
          file_url: pdf.url,
          file_name: fileName,
          doc_type: docType,
          uploaded_by: 'scraper',
        })
      )
      error = res.error
    } catch {
      error = { message: 'DB timeout' }
    }

    if (error) {
      console.error(`  ❌ INSERT error: ${JSON.stringify(error)}`)
    } else {
      saved++
      console.log(`  ✅ ${title}`)
    }
  }
  console.log(`  ✅ Сохранено в БД: ${saved} новых документов`)
}

async function main() {
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()

  for (const source of SOURCES) {
    console.log(`\n📁 ${source.brand}`)
    let allPDFs = []

    if (source.custom_scraper === 'rockwool') {
      allPDFs = await scrapeRockwool(page)
    } else {
      for (const url of source.doc_pages) {
        try {
          const pdfs = await scrapePage(page, url)
          allPDFs.push(...pdfs)
        } catch (e) {
          console.error(`  ❌ Ошибка: ${e.message}`)
        }
      }
    }

    fs.writeFileSync(
      `scripts/found-docs-${source.brand}.json`,
      JSON.stringify(allPDFs, null, 2),
      'utf-8'
    )

    if (allPDFs.length > 0) await saveToDB(allPDFs, source)
  }

  await browser.close()
  console.log('\n✅ Готово!')
}

main()
