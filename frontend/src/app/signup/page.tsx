import type { Metadata } from "next";
import React from "react";
import Image from "next/image";
import Link from "next/link";
import SignupForm from "./SignupForm";

export const metadata: Metadata = {
  title: "Create account | Signal",
  description: "Create a Signal account to run security scans on your codebase.",
};

export default function SignupPage() {
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
          Already have an account?{" "}
          <Link href="/login" className="login-minimal__signup-link">
            Log in →
          </Link>
        </p>
      </header>

      <div className="login-minimal__center">
        <div className="login-minimal__card">
          <h1 className="login-minimal__title">Create your account</h1>
          <SignupForm />
        </div>
      </div>
    </main>
  );
}
