import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic()

export async function POST(req: NextRequest) {
  try {
    const { screenshot, site } = await req.json()

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: screenshot },
            },
            {
              type: 'text',
              text: `Это скриншот сайта ${site}. Найди все ссылки на PDF документы (техлисты, сертификаты, каталоги). Верни JSON массив: [{"url": "...", "title": "..."}]. Только JSON, без пояснений.`,
            },
          ],
        },
      ],
    })

    const text =
      response.content[0].type === 'text' ? response.content[0].text : '[]'
    try {
      const clean = text.replace(/```json|```/g, '').trim()
      return NextResponse.json({ pdfs: JSON.parse(clean) })
    } catch {
      return NextResponse.json({ pdfs: [] })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return NextResponse.json({ error: message, pdfs: [] }, { status: 500 })
  }
}
