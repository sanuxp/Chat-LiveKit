import { useState } from "react";

export function Login({ onLogin, error }: { onLogin: (u: string, p: string) => Promise<void>; error: string | null }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <div className="login">
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
          <input value={user} onChange={(e) => setUser(e.target.value)} placeholder="agent_alice" autoFocus autoComplete="username" />
        </label>
        <label>
          Password
          <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} autoComplete="current-password" />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy || !user || !pass}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </div>
  );
}
