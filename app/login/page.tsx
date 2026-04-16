"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");

  const signIn = async () => {
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setMessage("Supabase env переменные не настроены.");
      return;
    }
    console.log("[login] signInWithPassword:start", { email });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      console.log("[login] signInWithPassword:error", error.message);
      setMessage(error.message);
      return;
    }
    console.log("[login] signInWithPassword:ok", { hasUser: Boolean(data?.user), hasSession: Boolean(data?.session) });
    if (data?.user) {
      router.push("/admin");
      router.refresh();
      return;
    }
    setMessage("Вход выполнен, но сессия не создана. Проверьте настройки Supabase Auth.");
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    await signIn();
  };

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="mb-3 text-2xl font-bold">Вход в админку</h1>
      <form onSubmit={handleSubmit}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          autoComplete="email"
          className="mb-3 w-full rounded border p-2"
          placeholder="you@company.com"
          required
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type="password"
          autoComplete="current-password"
          className="mb-3 w-full rounded border p-2"
          placeholder="Пароль"
          required
        />
        <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-white">
          Войти
        </button>
      </form>
      {message && <p className="mt-3 text-sm text-slate-600">{message}</p>}
    </main>
  );
}
