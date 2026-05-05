#!/usr/bin/env node
/**
 * Импорт 18,609 позиций в Supabase через API
 * База знаний ТСТН
 *
 * Использование:
 *   npm install @supabase/supabase-js
 *   SUPABASE_URL=https://xxx.supabase.co SUPABASE_KEY=your_service_role_key node import_products.js
 *
 * Опции:
 *   DRY_RUN=true   — только показать статистику без записи
 *   START_BATCH=10 — начать с батча №10 (для возобновления)
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
const DRY_RUN     = process.env.DRY_RUN === 'true';
const START_BATCH = parseInt(process.env.START_BATCH || '0');
const BATCH_SIZE  = 100; // Supabase API: safe batch size

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Укажите SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Шаг 1: Создать новые колонки ──────────────────────────────
async function ensureColumns() {
  console.log('🔧 Создаём новые колонки если нет...');
  
  const sqls = [
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS revenue_3y   NUMERIC DEFAULT 0`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS qty_3y       NUMERIC DEFAULT 0`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS category_type TEXT`,
    `ALTER TABLE products ADD COLUMN IF NOT EXISTS is_old       BOOLEAN DEFAULT false`,
  ];

  for (const sql of sqls) {
    const { error } = await supabase.rpc('exec_sql', { sql }).single();
    // If rpc not available, skip — columns might already exist
    if (error && !error.message.includes('already exists')) {
      console.warn(`  ⚠️  ${sql.slice(0, 60)}... → ${error.message}`);
    }
  }
  console.log('  ✅ Колонки готовы');
}

// ── Шаг 2: Загрузить данные ───────────────────────────────────
async function importProducts(products) {
  const batches = [];
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    batches.push(products.slice(i, i + BATCH_SIZE));
  }

  console.log(`\n📦 Батчей: ${batches.length} по ${BATCH_SIZE} записей`);
  console.log(`   Старт с батча: ${START_BATCH + 1}`);

  let inserted = 0;
  let updated  = 0;
  let errors   = 0;

  for (let i = START_BATCH; i < batches.length; i++) {
    const batch = batches[i];
    const rows  = batch.map(p => ({
      name:            p.name?.slice(0, 500) || '',
      kod_1c:          p.kod_1c  || null,
      code_1c:         p.kod_1c  || null,   // initially same as kod_1c
      code_1c_parent:  p.code_1c_parent || null,
      category_type:   p.category_type  || 'other',
      revenue_3y:      p.revenue_3y     || 0,
      qty_3y:          p.qty_3y         || 0,
      is_active:       p.is_active      !== false,
      is_old:          p.is_old         || false,
    }));

    if (DRY_RUN) {
      console.log(`  [DRY] Батч ${i+1}/${batches.length}: ${batch.length} записей`);
      if (i < 2) {
        console.log('  Пример:', JSON.stringify(rows[0], null, 2));
      }
      continue;
    }

    const { data, error, count } = await supabase
      .from('products')
      .upsert(rows, {
        onConflict:        'kod_1c',
        ignoreDuplicates:  false,
      });

    if (error) {
      console.error(`  ❌ Батч ${i+1} ошибка: ${error.message}`);
      errors++;
      // Retry once
      await new Promise(r => setTimeout(r, 2000));
      const { error: err2 } = await supabase.from('products').upsert(rows, { onConflict: 'kod_1c' });
      if (err2) {
        console.error(`  ❌ Повтор тоже упал: ${err2.message}`);
        console.error(`  💾 Для возобновления запустите: START_BATCH=${i} node import_products.js`);
        process.exit(1);
      }
    }

    inserted += batch.length;

    // Progress
    const pct  = Math.round((i + 1) / batches.length * 100);
    const done = Math.round(pct / 5);
    const bar  = '█'.repeat(done) + '░'.repeat(20 - done);
    process.stdout.write(`\r  [${bar}] ${pct}% | Батч ${i+1}/${batches.length} | ${inserted.toLocaleString()} записей`);

    // Pause every 10 batches to avoid rate limits
    if ((i + 1) % 10 === 0) {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log('\n');
  return { inserted, errors };
}

// ── Шаг 3: Статистика ─────────────────────────────────────────
async function printStats() {
  const { data, error } = await supabase
    .from('products')
    .select('category_type, is_active, is_old, revenue_3y')
    .not('revenue_3y', 'is', null);

  if (error) { console.error('Ошибка статистики:', error.message); return; }

  const stats = {};
  let total = 0, active = 0, old = 0, totalRev = 0;

  for (const row of data) {
    total++;
    if (row.is_active) active++;
    if (row.is_old) old++;
    totalRev += parseFloat(row.revenue_3y || 0);
    const cat = row.category_type || 'other';
    stats[cat] = (stats[cat] || 0) + 1;
  }

  console.log('\n📊 Итоговая статистика:');
  console.log(`  Всего записей:    ${total.toLocaleString()}`);
  console.log(`  Активных:         ${active.toLocaleString()}`);
  console.log(`  Архивных (is_old):${old.toLocaleString()}`);
  console.log(`  Выручка 3 года:   ${(totalRev/1e9).toFixed(2)} млрд руб`);
  console.log('\n  По категориям:');
  for (const [cat, cnt] of Object.entries(stats).sort((a,b) => b[1]-a[1])) {
    console.log(`    ${cat.padEnd(22)}: ${cnt.toLocaleString()}`);
  }
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Импорт продуктов в Supabase');
  console.log(`   URL:    ${SUPABASE_URL}`);
  console.log(`   Режим:  ${DRY_RUN ? 'DRY RUN' : 'ЗАПИСЬ'}`);

  // Load data
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const dataPath  = path.join(__dirname, 'products_data.json');
  
  let products;
  try {
    products = JSON.parse(readFileSync(dataPath, 'utf-8'));
  } catch(e) {
    console.error(`❌ Файл не найден: ${dataPath}`);
    console.error('   Поместите products_data.json рядом со скриптом');
    process.exit(1);
  }

  console.log(`\n📂 Загружено из JSON: ${products.length.toLocaleString()} позиций`);
  console.log(`   Активных:  ${products.filter(p => p.is_active).length.toLocaleString()}`);
  console.log(`   Архивных:  ${products.filter(p => p.is_old).length.toLocaleString()}`);

  if (!DRY_RUN) {
    await ensureColumns();
  }

  const { inserted, errors } = await importProducts(products);

  if (!DRY_RUN) {
    console.log(`✅ Загружено: ${inserted.toLocaleString()} | Ошибок батчей: ${errors}`);
    await printStats();
  }

  console.log('\n✅ Готово!');
}

main().catch(e => {
  console.error('❌ Критическая ошибка:', e.message);
  process.exit(1);
});
