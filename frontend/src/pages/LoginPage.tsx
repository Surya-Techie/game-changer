import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../store/auth";
import { Mail, Lock, Activity, ArrowRight } from "lucide-react";
import { apiErrorMessage } from "../lib/errors";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setSession = useAuth((s) => s.setSession);
  const nav = useNavigate();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { data } = await api.post("/api/auth/login", { email, password });
      setSession(data.token, data.user);
      nav("/");
    } catch (err) {
      setError(apiErrorMessage(err, "Login failed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative min-h-screen flex items-center justify-center px-4 bg-app-radial overflow-hidden select-none">
      {/* Dynamic Background Mesh Blobs */}
      <div className="absolute top-1/4 left-1/4 w-[350px] h-[350px] rounded-full bg-accent-info/8 blur-[100px] animate-float-slow pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-[400px] h-[400px] rounded-full bg-accent-buy/5 blur-[120px] animate-float-slow pointer-events-none [animation-delay:3s]" />

      {/* Main Glass Card */}
      <div className="relative w-full max-w-md bg-bg-panel border border-bg-border rounded-2xl p-8 backdrop-blur-glass shadow-glass z-10 transition-all duration-300">
        {/* Decorative Card Header Glow */}
        <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-accent-info via-indigo-500 to-transparent rounded-t-2xl opacity-60" />

        {/* Branding header */}
        <div className="flex flex-col items-center mb-8">
          <div className="relative flex items-center justify-center h-12 w-12 rounded-xl bg-gradient-to-tr from-accent-info to-indigo-700 shadow-glow-indigo mb-3">
            <Activity className="h-6 w-6 text-white animate-pulse-slow" />
          </div>
          <h2 className="text-2xl font-black text-white font-display tracking-tight flex items-center gap-1.5">
            QTI <span className="h-1.5 w-1.5 rounded-full bg-accent-buy animate-pulse" />
          </h2>
          <p className="text-xs font-semibold text-slate-500 tracking-wider uppercase mt-1">
            Quick Trade Insights
          </p>
        </div>

        <h1 className="text-xl font-bold font-display text-white mb-6 text-center">Welcome Back</h1>
        
        <form onSubmit={onSubmit} className="space-y-5">
          {/* Email input */}
          <Field label="Email Address">
            <div className="relative">
              <Mail className="absolute left-3.5 top-3.5 h-4 w-4 text-slate-500" />
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input pl-10"
                placeholder="you@example.com"
              />
            </div>
          </Field>

          {/* Password input */}
          <Field label="Password">
            <div className="relative">
              <Lock className="absolute left-3.5 top-3.5 h-4 w-4 text-slate-500" />
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="input pl-10"
                placeholder="••••••••"
              />
            </div>
          </Field>

          {error && (
            <div className="p-3.5 rounded-xl border border-accent-sell/20 bg-accent-sell/5 text-sm text-accent-sell font-semibold leading-snug">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary w-full h-[44px] flex items-center justify-center gap-2 group font-bold mt-2"
          >
            <span>{loading ? "Signing in…" : "Sign In"}</span>
            {!loading && <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />}
          </button>
        </form>

        <div className="mt-6 text-sm text-slate-500 text-center font-medium">
          No account?{" "}
          <Link to="/register" className="text-accent-info hover:text-indigo-400 font-bold transition-colors">
            Create an account
          </Link>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="block">
      <span className="text-xs font-bold text-slate-400 mb-1.5 inline-block uppercase tracking-wider font-display">
        {label}
      </span>
      {children}
    </div>
  );
}
