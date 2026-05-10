import { NextRequest, NextResponse } from 'next/server'

type PdfHit = { url: string; title: string }

export async function POST(req: NextRequest) {
  try {
    const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET
    if (INTERNAL_SECRET) {
      const authHeader = req.headers.get('x-internal-secret')
      if (authHeader !== INTERNAL_SECRET) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
      }
    }

    const { brand, site } = await req.json()

    if (!brand || !site || typeof brand !== 'string' || typeof site !== 'string') {
      return NextResponse.json(
        { pdfs: [], error: 'brand and site (strings) are required' },
        { status: 400 }
      )
    }

    const siteKey = site.replace('www.', '')

    const queries = [
      `${brand} технический лист PDF`,
      `${brand} сертификат соответствия PDF`,
      `${brand} каталог продукции PDF скачать`,
    ]

    const allPdfs: PdfHit[] = []

    for (let qi = 0; qi < queries.length; qi++) {
      const query = queries[qi]
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=ru-ru`
        const response = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
            Referer: 'https://duckduckgo.com/',
          },
        })
        const html = await response.text()

        const linkMatches = html.match(/uddg=(https?[^&"]+)/gi) || []
        const pdfLinks: string[] = []

        linkMatches.forEach((match) => {
          try {
            const encoded = match.replace(/^uddg=/i, '')
            const decoded = decodeURIComponent(encoded)
            if (decoded.toLowerCase().includes('.pdf') && decoded.includes(siteKey)) {
              pdfLinks.push(decoded)
            }
          } catch {
            /* ignore malformed encoding */
          }
        })

        const directPdfs = html.match(/https?:\/\/[^\s"'<>]+\.pdf/gi) || []
        directPdfs.forEach((u) => {
          if (u.includes(siteKey)) pdfLinks.push(u)
        })

        if (qi === 0) {
          console.log('HTML length:', html.length)
          console.log('HTML sample:', html.substring(0, 500))
          console.log('Link matches:', linkMatches.length)
          console.log('PDF links found:', pdfLinks.length)
        }

        const uniqueUrls = [...new Set(pdfLinks)]
        const pdfsForQuery: PdfHit[] = uniqueUrls.map((pdfUrl) => ({
          url: pdfUrl,
          title:
            pdfUrl.split('/').pop()?.replace(/\.pdf$/i, '').replace(/_/g, ' ') || 'document',
        }))
        allPdfs.push(...pdfsForQuery)
      } catch (e) {
        console.error('Search error:', e)
      }
    }

    const unique = Array.from(new Map(allPdfs.map((p) => [p.url, p])).values())
    return NextResponse.json({ pdfs: unique })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ pdfs: [], error: message }, { status: 500 })
  }
}
