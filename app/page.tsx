export default function HomePage() {
  return (
    <main className="mx-auto max-w-5xl p-6">
      <h1 className="text-2xl font-bold">Insulation Knowledge Base</h1>
      <p className="mt-3 text-slate-700">
        Project bootstrap is complete: seed data, API routes, and admin panel.
      </p>
      <a
        href="/project-upload"
        className="mt-6 inline-flex rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
      >
        Загрузить PDF проекта
      </a>
    </main>
  );
}
