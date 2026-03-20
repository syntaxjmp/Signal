import type { Metadata } from "next";
import React from "react";
import Image from "next/image";
import Link from "next/link";
import LoginForm from "./LoginForm";

export const metadata: Metadata = {
  title: "Sign in | Signal",
  description: "Sign in to Signal to run security scans on your codebase.",
};

export default function LoginPage() {
  return (
    <main className="login-minimal flex flex-1 flex-col w-full min-h-0">
      <header className="login-minimal__header">
        <Link href="/" className="login-minimal__brand" aria-label="Signal home">
          <Image
            src="/signal_transparent.png"
            alt=""
            width={140}
            height={140}
            className="login-minimal__brand-mark"
            priority
          />
          <span className="login-minimal__brand-text">Signal</span>
        </Link>
        <p className="login-minimal__signup">
          Don&apos;t have an account?{" "}
          <Link href="#" className="login-minimal__signup-link">
            Sign up →
          </Link>
        </p>
      </header>

      <div className="login-minimal__center">
        <div className="login-minimal__card">
          <h1 className="login-minimal__title">Log in to your account</h1>
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
