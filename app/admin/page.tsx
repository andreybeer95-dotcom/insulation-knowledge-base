import Link from "next/link";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold">Панель администратора</h1>
      <p className="mt-2 text-slate-600">Управляйте продуктами, правилами и документами.</p>
      <div className="mt-4">
        <Link href="/admin/products" className="rounded bg-slate-900 px-4 py-2 text-white">
          Перейти к продуктам
        </Link>
      </div>
    </div>
  );
}
