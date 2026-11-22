import { useState } from "react";

export function Login({ onLogin, error }: { onLogin: (u: string, p: string) => Promise<void>; error: string | null }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <main className="login" id="main">
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try { await onLogin(user.trim(), pass); } finally { setBusy(false); }
        }}
      >
        <h1>Agent console</h1>
        <label>
          Username
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="agent_alice" autoFocus autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" required aria-describedby={error ? "login-error" : undefined} />
        </label>
        {error && <p className="error" id="login-error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !user || !pass}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}
