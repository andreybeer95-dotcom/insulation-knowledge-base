const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  'https://insulation-knowledge-base-production.up.railway.app'

const r = await fetch(`${SITE_URL}/api/find-docs`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-internal-secret': process.env.INTERNAL_API_SECRET || '',
  },
  body: JSON.stringify({ brand: 'URSA', site: 'ursa.ru' }),
})
const d = await r.json()
console.log('Result:', JSON.stringify(d, null, 2))
