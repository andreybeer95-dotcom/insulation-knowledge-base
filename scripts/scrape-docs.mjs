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
    ]
  },
  {
    brand: 'ROCKWOOL',
    manufacturer_id: '6f22e435-08cc-46ab-ba45-d119ce497581',
    doc_pages: [
      'https://rwl.ru/resources-and-tools/docs/',
    ]
  },
  {
    brand: 'ИЗОСПАН',
    manufacturer_id: null,
    name_ru: 'ИЗОСПАН',
    doc_pages: ['https://isospan.gexa.ru/'],
    deep: true,
  },
  {
    brand: 'ОНДУТИС',
    manufacturer_id: null,
    name_ru: 'ОНДУТИС',
    doc_pages: ['https://ondutiss.pro/'],
    deep: true,
  },
  {
    brand: 'ПЕНЕТРОН',
    manufacturer_id: '2687b7ce-c178-4f81-a6c1-355fd82e6e08',
    doc_pages: ['https://penetron.ru/'],
    deep: true,
  },
  {
    brand: 'BASWOOL',
    manufacturer_id: 'c0f1731c-12a2-4d6a-bca3-6020711de7f5',
    doc_pages: ['https://www.baswool.ru/catalog/'],
    deep: true,
  },
  {
    brand: 'ТЕРМАФЛЕКС',
    manufacturer_id: null,
    name_ru: 'ТЕРМАФЛЕКС',
    doc_pages: [
      'https://thermaflex.ru/products/',
    ]
  },
  {
    brand: 'ИМПЕР',
    manufacturer_id: 'f03dbf70-77b2-464b-892d-ba9ec14af826',
    doc_pages: [
      'https://tn.ru/catalog/gidroizolyatsiya/rulonnye-bitumnye-materialy/imper/',
    ]
  },
]

async function crawlSiteForPDFs(page, startUrl, maxPages = 50) {
  const visited = new Set()
  const toVisit = [startUrl]
  const foundPdfs = []
  let domain
  try {
    domain = new URL(startUrl).hostname
  } catch {
    console.error(`  Некорректный startUrl: ${startUrl}`)
    return []
  }

  while (toVisit.length > 0 && visited.size < maxPages) {
    const url = toVisit.shift()
    if (!url || visited.has(url)) continue
    visited.add(url)

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 })
      await page.waitForTimeout(1000)

      const pdfs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .filter((a) => a.href.toLowerCase().includes('.pdf'))
          .map((a) => ({
            url: a.href,
            title: a.textContent.trim() || a.href.split('/').pop(),
          }))
      })
      foundPdfs.push(...pdfs)

      const links = await page.evaluate((d) => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map((a) => a.href)
          .filter((href) => {
            try {
              const u = new URL(href)
              return (
                u.hostname === d &&
                !href.includes('#') &&
                !href.match(/\.(jpg|png|gif|css|js|zip|xml)$/i)
              )
            } catch {
              return false
            }
          })
      }, domain)

      links.forEach((link) => {
        if (!visited.has(link) && !toVisit.includes(link)) toVisit.push(link)
      })

      if (foundPdfs.length > 0) {
        console.log(`  ${url}: найдено ${pdfs.length} PDF (всего: ${foundPdfs.length})`)
      }
    } catch {
      /* skip failed pages */
    }
  }

  const unique = Array.from(new Map(foundPdfs.map((p) => [p.url, p])).values())
  console.log(`  Просканировано страниц: ${visited.size}, найдено PDF: ${unique.length}`)
  return unique
}

async function scrapePageDeep(page, url) {
  console.log(`  Открываем: ${url}`)
  const foundPdfs = new Set()

  const onResponse = async (response) => {
    const resUrl = response.url()
    if (resUrl.toLowerCase().includes('.pdf')) {
      foundPdfs.add(resUrl)
    }
    try {
      const ct = response.headers()['content-type'] || ''
      if (ct.includes('json') && response.status() === 200) {
        const text = await response.text()
        const matches = text.match(/https?:\/\/[^\s"']+\.pdf/gi) || []
        matches.forEach((m) => foundPdfs.add(m))
        const relMatches = text.match(/["'](\/[^"']*\.pdf)["']/gi) || []
        relMatches.forEach((m) => {
          const clean = m.replace(/["']/g, '')
          try {
            const base = new URL(url)
            foundPdfs.add(base.origin + clean)
          } catch {}
        })
      }
    } catch {}
  }

  page.on('response', onResponse)

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })

    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollBy(0, 500))
      await page.waitForTimeout(300)
    }

    const loadMoreSelectors = [
      'button:has-text("Загрузить ещё")',
      'button:has-text("Показать ещё")',
      'button:has-text("Ещё")',
      '.load-more',
      '[class*="load-more"]',
      '[class*="show-more"]',
    ]
    for (const sel of loadMoreSelectors) {
      try {
        const btn = await page.$(sel)
        if (btn) {
          await btn.click()
          await page.waitForTimeout(2000)
        }
      } catch {}
    }

    await page.waitForTimeout(2000)

    const domLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a[href]'))
        .map((a) => a.href)
        .filter((h) => h.toLowerCase().includes('.pdf'))
    })
    domLinks.forEach((l) => foundPdfs.add(l))

    const results = Array.from(foundPdfs).map((pdfUrl) => ({
      url: pdfUrl,
      title: pdfUrl.split('/').pop().replace('.pdf', '').replace(/_/g, ' ')
    }))

    console.log(`  Найдено PDF: ${results.length}`)
    return results
  } catch (e) {
    console.error(`  ❌ ${e.message}`)
    return []
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
    const allPDFs = []

    for (const docUrl of source.doc_pages) {
      try {
        const pdfs = source.deep
          ? await crawlSiteForPDFs(page, docUrl, 50)
          : await scrapePageDeep(page, docUrl)
        allPDFs.push(...pdfs)
      } catch (e) {
        console.error(`  ❌ Ошибка: ${e.message}`)
      }
    }

    const unique = Array.from(new Map(allPDFs.map((p) => [p.url, p])).values())

    fs.writeFileSync(
      `scripts/found-docs-${source.brand}.json`,
      JSON.stringify(unique, null, 2),
      'utf-8'
    )

    if (unique.length > 0) await saveToDB(unique, source)
  }

  await browser.close()
  console.log('\n✅ Готово!')
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
