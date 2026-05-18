import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const nomenclaturePath = path.join(__dirname, 'nomenclature_data.json')
const productsPath = path.join(__dirname, 'products_data.json')
const reportDir = path.join(rootDir, 'reports')

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'))
const normalize = (value) => String(value ?? '').trim()

const nomenclature = readJson(nomenclaturePath)
const products = readJson(productsPath)
const productsByCode = new Map(products.map((item) => [normalize(item.kod_1c), item]))

const byCategory = new Map()
const byParent = new Map()
const missingProductMeta = []
const sourceOther = []

for (const item of nomenclature) {
  const code = normalize(item.code)
  const product = productsByCode.get(code)
  if (!product) {
    missingProductMeta.push(item)
    continue
  }

  const category = normalize(product.category_type) || 'empty_category_type'
  byCategory.set(category, (byCategory.get(category) ?? 0) + 1)

  const parent = normalize(product.code_1c_parent) || 'empty_parent'
  byParent.set(parent, (byParent.get(parent) ?? 0) + 1)

  if (category === 'other') {
    sourceOther.push({
      code,
      name: item.name,
      brand: item.brand,
      code_1c_parent: product.code_1c_parent ?? null,
    })
  }
}

const sortCounts = (map) =>
  Array.from(map.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key, 'ru'))

const report = {
  generated_at: new Date().toISOString(),
  totals: {
    nomenclature_rows: nomenclature.length,
    products_rows: products.length,
    matched_by_code: nomenclature.length - missingProductMeta.length,
    missing_product_meta: missingProductMeta.length,
    source_category_other: sourceOther.length,
  },
  by_category_type: sortCounts(byCategory),
  top_parent_codes: sortCounts(byParent).slice(0, 80),
  samples: {
    missing_product_meta: missingProductMeta.slice(0, 200),
    source_category_other: sourceOther.slice(0, 200),
  },
}

fs.mkdirSync(reportDir, { recursive: true })
fs.writeFileSync(
  path.join(reportDir, 'nomenclature-audit.json'),
  JSON.stringify(report, null, 2),
  'utf8'
)

const csvRows = [
  ['bucket', 'code', 'brand', 'parent_code', 'name'],
  ...missingProductMeta.slice(0, 500).map((item) => [
    'missing_product_meta',
    item.code,
    item.brand ?? '',
    '',
    item.name ?? '',
  ]),
  ...sourceOther.slice(0, 500).map((item) => [
    'source_category_other',
    item.code,
    item.brand ?? '',
    item.code_1c_parent ?? '',
    item.name ?? '',
  ]),
]

const escapeCsv = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`
fs.writeFileSync(
  path.join(reportDir, 'nomenclature-audit-samples.csv'),
  csvRows.map((row) => row.map(escapeCsv).join(',')).join('\n'),
  'utf8'
)

console.log(JSON.stringify(report.totals, null, 2))
console.log('\nBy category_type:')
for (const row of report.by_category_type) {
  console.log(`${row.key}: ${row.count}`)
}
