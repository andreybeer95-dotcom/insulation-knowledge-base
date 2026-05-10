const key = process.env.GOOGLE_SEARCH_KEY || process.env.GOOGLE_VISION_API_KEY
console.log('Key prefix:', key?.substring(0, 15))
const cx = '151b3458a9ab3480e'
const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=site:ursa.ru+filetype:pdf&num=5`

console.log('Key exists:', !!key)
console.log('URL:', url.replace(key, 'KEY_HIDDEN'))

const r = await fetch(url)
const d = await r.json()
console.log(JSON.stringify(d, null, 2))
