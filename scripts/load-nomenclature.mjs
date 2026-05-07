import { createClient } from '@supabase/supabase-js'
import * as fs from 'fs'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

const BRANDS_MAP = {
  'ТЕХНОНИКОЛЬ': ['технониколь', 'technonicol', 'технофас', 'техновент', 'техноруф', 'logicpir', 'logicroof', 'техноэласт', 'унифлекс', 'planter', 'aquamast', 'технолайт', 'техноблок'],
  'ROCKWOOL': ['rockwool', 'роквул'],
  'BASWOOL': ['baswool', 'басвул'],
  'ИКОПАЛ': ['икопал', 'icopal', 'виллафлекс', 'виллатекс'],
  'K-FLEX': ['k-flex', 'к-флекс', 'kflex'],
  'КРОЗ': ['кроз', 'вбор', 'огневент', 'firestill'],
  'PRO-МБОР': ['мбор', 'pro-мбор'],
  'КНАУФ': ['кнауф', 'knauf'],
  'ЗИКА': ['sika', 'зика'],
  'HOTROCK': ['hotrock', 'хотрок'],
  'ПЕНОПЛЭКС': ['пеноплэкс', 'penoplex', 'plastfoil'],
  'ISOVER': ['isover', 'изовер'],
  'ИЗОБОКС': ['изобокс', 'isobox'],
  'ПАРОК': ['парок', 'paroc'],
  'ЭКОРОЛЛ': ['экоролл'],
  'ЦЕРЕЗИТ': ['церезит', 'ceresit'],
  'ОСНОВИТ': ['основит'],
  'ПЛИТОНИТ': ['плитонит'],
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY не заданы')
  process.exit(1)
}

const data = JSON.parse(fs.readFileSync('./scripts/nomenclature_data.json', 'utf-8'))

async function load() {
  console.log(`Loading ${data.length} rows...`)
  for (let i = 0; i < data.length; i += 500) {
    const chunk = data.slice(i, i + 500)
    const { error } = await supabase.from('nomenclature_1c').insert(chunk)
    if (error) { console.error('Error:', error); break }
    console.log(`Chunk ${Math.floor(i / 500) + 1}/${Math.ceil(data.length / 500)} done`)
  }
  console.log('Complete!')
}

load()
