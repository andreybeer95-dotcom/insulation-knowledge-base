"use client";

import { useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  const signIn = async () => {
    const supabase = getBrowserSupabase();
    if (!supabase) {
      setMessage("Supabase env переменные не настроены.");
      return;
    }
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: siteUrl + "/admin" }
    });
    if (error) setMessage(error.message);
    else setMessage("Ссылка для входа отправлена на email.");
  };

  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="mb-3 text-2xl font-bold">Вход в админку</h1>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mb-3 w-full rounded border p-2"
        placeholder="you@company.com"
      />
      <button onClick={signIn} className="rounded bg-slate-900 px-4 py-2 text-white">Войти по email</button>
      {message && <p className="mt-3 text-sm text-slate-600">{message}</p>}
    </main>
  );
}
