import { NextRequest, NextResponse } from 'next/server'

type PdfHit = { url: string; title: string }

interface GoogleCseItem {
  link?: string
  title?: string
}

interface GoogleCseResponse {
  items?: GoogleCseItem[]
  error?: { message?: string; code?: number }
}

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

    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || process.env.GOOGLE_VISION_API_KEY
    const SEARCH_ENGINE_ID = '151b3458a9ab3480e'

    if (!GOOGLE_API_KEY) {
      return NextResponse.json(
        { pdfs: [], error: 'GOOGLE_API_KEY or GOOGLE_VISION_API_KEY is not configured' },
        { status: 500 }
      )
    }

    const queries = [
      `site:${site} filetype:pdf технический лист`,
      `site:${site} filetype:pdf сертификат`,
      `site:${site} filetype:pdf каталог`,
      `site:${site} filetype:pdf`,
    ]

    const allPdfs: PdfHit[] = []

    for (const query of queries) {
      try {
        const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(GOOGLE_API_KEY)}&cx=${SEARCH_ENGINE_ID}&q=${encodeURIComponent(query)}&num=10`
        const response = await fetch(url)
        const data = (await response.json()) as GoogleCseResponse

        if (data.items) {
          for (const item of data.items) {
            const link = item.link
            if (link?.toLowerCase().includes('.pdf')) {
              allPdfs.push({
                url: link,
                title: item.title || link.split('/').pop() || 'document',
              })
            }
          }
        }

        if (data.error) {
          console.error('Google API error:', data.error)
        }
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
