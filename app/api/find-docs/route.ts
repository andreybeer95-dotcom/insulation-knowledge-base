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

    const queries = [
      `site:${site} filetype:pdf технический лист`,
      `site:${site} filetype:pdf сертификат`,
      `site:${site} filetype:pdf каталог`,
    ]

    const allPdfs: PdfHit[] = []

    for (let qi = 0; qi < queries.length; qi++) {
      const query = queries[qi]
      try {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; DocBot/1.0)',
          },
        })
        const html = await response.text()

        const pdfMatches = html.match(/https?:\/\/[^\s"'<>]+\.pdf/gi) || []
        if (qi === 0) {
          console.log('HTML length:', html.length)
          console.log('HTML sample:', html.substring(0, 500))
          console.log('PDF matches found:', pdfMatches.length)
        }
        const titleMatches = html.match(/<a[^>]*class="result__a"[^>]*>([^<]+)<\/a>/gi) || []

        pdfMatches.forEach((pdfUrl, i) => {
          if (pdfUrl.includes(site)) {
            allPdfs.push({
              url: pdfUrl,
              title:
                titleMatches[i]?.replace(/<[^>]+>/g, '').trim() ||
                pdfUrl.split('/').pop() ||
                'document',
            })
          }
        })
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
