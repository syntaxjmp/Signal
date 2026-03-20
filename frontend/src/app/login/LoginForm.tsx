"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import PasswordField from "./PasswordField";

export default function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [errorTick, setErrorTick] = useState(0);
  const [pending, setPending] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const email = String(fd.get("email") ?? "").trim();
    const password = String(fd.get("password") ?? "");

    const { error: signError } = await authClient.signIn.email({
      email,
      password,
      callbackURL: "/dashboard",
    });

    setPending(false);
    if (signError) {
      setErrorTick((t) => t + 1);
      setError(signError.message ?? "Could not sign in");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <form className="login-minimal__form" onSubmit={handleSubmit}>
      <div className="login-minimal__field">
        <label className="visually-hidden" htmlFor="login-email">
          Email
        </label>
        <div className="login-minimal__input-wrap">
          <span className="login-minimal__input-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            className="login-minimal__input"
            placeholder="Email"
            required
            disabled={pending}
          />
        </div>
      </div>

      <PasswordField disabled={pending} />

      <a href="#" className="login-minimal__forgot">
        Don&apos;t remember your password?
      </a>

      <button type="submit" className="login-minimal__submit" disabled={pending}>
        {pending ? "Signing in…" : "Log In"}
      </button>

      {error ? (
        <div className="login-minimal__error-slot" aria-live="polite">
          <p key={errorTick} className="login-minimal__error" role="alert">
            {error}
          </p>
        </div>
      ) : null}
    </form>
  );
}
