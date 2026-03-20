"use client";

import React, { useId, useState } from "react";

type Props = {
  disabled?: boolean;
  /** Form field name (default `password`). */
  inputName?: string;
  autoComplete?: string;
  placeholder?: string;
  label?: string;
};

export default function PasswordField({
  disabled = false,
  inputName = "password",
  autoComplete = "current-password",
  placeholder = "Password",
  label = "Password",
}: Props) {
  const [visible, setVisible] = useState(false);
  const id = useId();

  return (
    <div className="login-minimal__field">
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <div className="login-minimal__input-wrap">
        <span className="login-minimal__input-icon" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </span>
        <input
          id={id}
          name={inputName}
          type={visible ? "text" : "password"}
          autoComplete={autoComplete}
          className="login-minimal__input login-minimal__input--password"
          placeholder={placeholder}
          required
          disabled={disabled}
        />
        <button
          type="button"
          className="login-minimal__eye"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide password" : "Show password"}
          disabled={disabled}
        >
          {visible ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
