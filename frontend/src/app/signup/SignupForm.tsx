"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import PasswordField from "../login/PasswordField";

export default function SignupForm() {
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
    const name = String(fd.get("name") ?? "").trim();
    const email = String(fd.get("email") ?? "").trim();
    const password = String(fd.get("password") ?? "");
    const confirm = String(fd.get("confirmPassword") ?? "");

    if (password !== confirm) {
      setPending(false);
      setErrorTick((t) => t + 1);
      setError("Passwords do not match");
      return;
    }

    const { error: signError } = await authClient.signUp.email({
      name,
      email,
      password,
      callbackURL: "/",
    });

    setPending(false);
    if (signError) {
      setErrorTick((t) => t + 1);
      setError(signError.message ?? "Could not create account");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form className="login-minimal__form" onSubmit={handleSubmit}>
      <div className="login-minimal__field">
        <label className="visually-hidden" htmlFor="signup-name">
          Name
        </label>
        <div className="login-minimal__input-wrap">
          <span className="login-minimal__input-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <input
            id="signup-name"
            name="name"
            type="text"
            autoComplete="name"
            className="login-minimal__input"
            placeholder="Name"
            required
            disabled={pending}
          />
        </div>
      </div>

      <div className="login-minimal__field">
        <label className="visually-hidden" htmlFor="signup-email">
          Email
        </label>
        <div className="login-minimal__input-wrap">
          <span className="login-minimal__input-icon" aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
              <rect width="20" height="16" x="2" y="4" rx="2" />
              <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7" />
            </svg>
          </span>
          <input
            id="signup-email"
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

      <PasswordField
        disabled={pending}
        autoComplete="new-password"
        placeholder="Password"
        label="Password"
      />
      <PasswordField
        disabled={pending}
        inputName="confirmPassword"
        autoComplete="new-password"
        placeholder="Confirm password"
        label="Confirm password"
      />

      <button type="submit" className="login-minimal__submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
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
