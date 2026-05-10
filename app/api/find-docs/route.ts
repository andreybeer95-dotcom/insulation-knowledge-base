import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const { brand, site } = await req.json()

    if (!brand || !site || typeof brand !== 'string' || typeof site !== 'string') {
      return NextResponse.json(
        { pdfs: [], error: 'brand and site (strings) are required' },
        { status: 400 }
      )
    }

    const key = process.env.PERPLEXITY_API_KEY
    if (!key) {
      return NextResponse.json(
        { pdfs: [], error: 'PERPLEXITY_API_KEY is not configured' },
        { status: 500 }
      )
    }

    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content:
              'Ты помощник который ищет PDF документы на сайтах производителей. Возвращай ТОЛЬКО JSON массив без пояснений.',
          },
          {
            role: 'user',
            content: `Найди все PDF файлы (технические листы, сертификаты, каталоги) производителя ${brand} на сайте ${site}.
Поищи по запросам:
- site:${site} filetype:pdf технический лист
- site:${site} filetype:pdf сертификат
- site:${site} filetype:pdf каталог

Верни JSON массив: [{"url": "https://полная-ссылка.pdf", "title": "название документа"}]
Только реальные прямые ссылки на PDF файлы. Только JSON.`,
          },
        ],
        search_domain_filter: [site],
        return_citations: true,
        search_recency_filter: 'month',
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      return NextResponse.json({ pdfs: [], error: err }, { status: 500 })
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[]
      citations?: unknown[]
    }
    const text = data.choices?.[0]?.message?.content || '[]'

    const citationsRaw = Array.isArray(data.citations) ? data.citations : []
    const citations = citationsRaw.filter((c): c is string => typeof c === 'string')
    const citationPdfs = citations
      .filter((c) => c.toLowerCase().includes('.pdf'))
      .map((c) => ({ url: c, title: c.split('/').pop() || 'document' }))

    try {
      const clean = text.replace(/```json|```/g, '').trim()
      const match = clean.match(/\[[\s\S]*\]/)
      const aiPdfs = match ? (JSON.parse(match[0]) as { url: string; title?: string }[]) : []
      const allPdfs = [...aiPdfs, ...citationPdfs]
      const unique = Array.from(new Map(allPdfs.map((p) => [p.url, p])).values())
      return NextResponse.json({ pdfs: unique, raw: text })
    } catch {
      return NextResponse.json({ pdfs: citationPdfs, raw: text })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ pdfs: [], error: message }, { status: 500 })
  }
}
