import { getServerSupabase } from "@/lib/server-supabase";

export const dynamic = "force-dynamic";

export default async function ChangelogPage() {
  const supabase = getServerSupabase();
  const { data } = await supabase
    .from("change_log")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div>
      <h1 className="mb-4 text-2xl font-bold">История изменений</h1>
      <table className="min-w-full text-sm">
        <thead><tr className="bg-slate-100"><th className="p-2">Дата</th><th className="p-2">Пользователь</th><th className="p-2">Таблица</th><th className="p-2">Действие</th><th className="p-2 text-left">Изменения</th></tr></thead>
        <tbody>
          {(data ?? []).map((row: any) => (
            <tr key={row.id} className="border-b">
              <td className="p-2">{new Date(row.created_at).toLocaleString()}</td>
              <td className="p-2">{row.changed_by ?? "-"}</td>
              <td className="p-2">{row.table_name}</td>
              <td className="p-2">{row.action}</td>
              <td className="p-2 font-mono text-xs">{JSON.stringify(row.changes)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
