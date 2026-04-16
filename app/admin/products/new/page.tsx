import ProductForm from "../ProductForm";

export const dynamic = "force-dynamic";

export default function NewProductPage() {
  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">Новый продукт</h1>
      <ProductForm />
    </div>
  );
}
