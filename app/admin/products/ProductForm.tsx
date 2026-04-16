"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

const schema = z.object({
  manufacturer_id: z.string().uuid(),
  name: z.string().min(1),
  product_type: z.enum(["вырезной", "навивной", "термонавивной"]),
  coating: z.string().min(1),
  flammability: z.enum(["НГ", "Г1", "КМ0"]),
  density_min: z.coerce.number().int().nullable().optional(),
  density_max: z.coerce.number().int().nullable().optional(),
  temp_min: z.coerce.number().int().nullable().optional(),
  temp_max: z.coerce.number().int().nullable().optional(),
  diameter_min: z.coerce.number().int().nullable().optional(),
  diameter_max: z.coerce.number().int().nullable().optional(),
  thickness_min: z.coerce.number().int().nullable().optional(),
  thickness_max: z.coerce.number().int().nullable().optional(),
  length: z.coerce.number().int().nullable().optional(),
  outdoor_use: z.boolean().default(false),
  is_active: z.boolean().default(true),
  application_notes: z.string().optional()
});

type FormValues = z.infer<typeof schema>;

export default function ProductForm({ id, initial }: { id?: string; initial?: Partial<FormValues> }) {
  const [manufacturers, setManufacturers] = useState<any[]>([]);
  const router = useRouter();
  const { register, handleSubmit, formState: { errors }, setValue } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { product_type: "вырезной", flammability: "НГ", outdoor_use: false, is_active: true, ...initial }
  });

  useEffect(() => {
    fetch("/api/manufacturers")
      .then((r) => r.json())
      .then((d) => setManufacturers(d.items ?? []));
  }, []);

  useEffect(() => {
    if (!initial) return;
    Object.entries(initial).forEach(([k, v]) => setValue(k as keyof FormValues, v as any));
  }, [initial, setValue]);

  const onSubmit = async (values: FormValues) => {
    const res = await fetch(id ? `/api/products/${id}` : "/api/products", {
      method: id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values)
    });
    if (res.ok) router.push("/admin/products");
    else alert("Ошибка сохранения");
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid grid-cols-2 gap-3">
      <select {...register("manufacturer_id")} className="rounded border p-2">
        <option value="">Выберите производителя</option>
        {manufacturers.map((m) => (
          <option value={m.id} key={m.id}>{m.name_ru}</option>
        ))}
      </select>
      <input {...register("name")} placeholder="Название" className="rounded border p-2" />
      <select {...register("product_type")} className="rounded border p-2">
        <option value="вырезной">вырезной</option>
        <option value="навивной">навивной</option>
        <option value="термонавивной">термонавивной</option>
      </select>
      <input {...register("coating")} placeholder="Покрытие" className="rounded border p-2" />
      <select {...register("flammability")} className="rounded border p-2">
        <option value="НГ">НГ</option>
        <option value="Г1">Г1</option>
        <option value="КМ0">КМ0</option>
      </select>
      <input {...register("density_min")} placeholder="Плотность min" className="rounded border p-2" />
      <input {...register("density_max")} placeholder="Плотность max" className="rounded border p-2" />
      <input {...register("temp_min")} placeholder="Температура min" className="rounded border p-2" />
      <input {...register("temp_max")} placeholder="Температура max" className="rounded border p-2" />
      <input {...register("diameter_min")} placeholder="Диаметр min" className="rounded border p-2" />
      <input {...register("diameter_max")} placeholder="Диаметр max" className="rounded border p-2" />
      <input {...register("thickness_min")} placeholder="Толщина min" className="rounded border p-2" />
      <input {...register("thickness_max")} placeholder="Толщина max" className="rounded border p-2" />
      <input {...register("length")} placeholder="Длина" className="rounded border p-2" />
      <input {...register("application_notes")} placeholder="Примечания" className="col-span-2 rounded border p-2" />
      <label className="flex items-center gap-2"><input type="checkbox" {...register("outdoor_use")} /> Outdoor use</label>
      <label className="flex items-center gap-2"><input type="checkbox" {...register("is_active")} /> Активен</label>
      <button type="submit" className="col-span-2 rounded bg-slate-900 px-4 py-2 text-white">
        Сохранить
      </button>
      {Object.keys(errors).length > 0 && <p className="col-span-2 text-sm text-red-600">Проверьте поля формы.</p>}
    </form>
  );
}
