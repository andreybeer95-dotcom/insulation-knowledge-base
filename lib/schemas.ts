import { z } from "zod";

export const productSchema = z.object({
  manufacturer_id: z.string().uuid(),
  name: z.string().min(1),
  product_type: z.enum(["вырезной", "навивной", "термонавивной"]),
  coating: z.string().min(1),
  flammability: z.enum(["НГ", "Г1", "КМ0"]),
  density_min: z.number().int().nullable().optional(),
  density_max: z.number().int().nullable().optional(),
  temp_min: z.number().int().nullable().optional(),
  temp_max: z.number().int().nullable().optional(),
  diameter_min: z.number().int().nullable().optional(),
  diameter_max: z.number().int().nullable().optional(),
  thickness_min: z.number().int().nullable().optional(),
  thickness_max: z.number().int().nullable().optional(),
  length: z.number().int().nullable().optional(),
  lambda_10: z.number().nullable().optional(),
  lambda_25: z.number().nullable().optional(),
  lambda_125: z.number().nullable().optional(),
  lambda_300: z.number().nullable().optional(),
  has_lock: z.boolean().optional(),
  lock_type: z.string().nullable().optional(),
  outdoor_use: z.boolean().optional(),
  application_notes: z.string().nullable().optional(),
  is_active: z.boolean().optional()
});

export const ruleSchema = z.object({
  rule_name: z.string().min(1),
  condition: z.string().min(1),
  rule_text: z.string().min(1),
  priority: z.number().int().min(1).max(10),
  is_prohibition: z.boolean()
});

export const manufacturerSchema = z.object({
  name_ru: z.string().min(1),
  name_en: z.string().nullable().optional(),
  synonyms: z.array(z.string()).optional().default([]),
  website: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  tu: z.string().nullable().optional()
});

export const noteSchema = z.object({
  category: z.enum(["правило", "совет", "скрипт продаж", "FAQ", "дополнение"]),
  title: z.string().min(1),
  content: z.string().min(1),
  product_id: z.string().uuid().nullable().optional(),
  manufacturer_id: z.string().uuid().nullable().optional(),
  tags: z.array(z.string()).optional().default([]),
  is_active: z.boolean().optional().default(true),
  created_by: z.string().nullable().optional()
});

export const priceSchema = z.object({
  product_id: z.string().uuid(),
  price: z.number().positive(),
  unit: z.enum(["пм", "шт", "м²"]),
  currency: z.string().default("RUB"),
  supplier: z.string().nullable().optional(),
  valid_from: z.string(),
  valid_until: z.string().nullable().optional(),
  notes: z.string().nullable().optional()
});
