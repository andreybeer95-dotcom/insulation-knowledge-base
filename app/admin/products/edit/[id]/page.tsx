import ProductForm from "../../ProductForm";
import { getServerSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

export default async function EditProductPage({ params }: { params: { id: string } }) {
  const supabase = getServerSupabase();
  const { data } = await supabase.from("products").select("*").eq("id", params.id).single();

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Редактирование продукта</h1>
      <ProductForm id={params.id} initial={data ?? {}} />
    </div>
  );
}
