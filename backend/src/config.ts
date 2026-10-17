function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
const opt = (name: string, def = ""): string => process.env[name] || def;

export const config = {
  backendPort: Number(opt("BACKEND_PORT", "3000")),
  databaseUrl: req("DATABASE_URL"),
  jwtSecret: req("BACKEND_JWT_SECRET"),
  adminApiToken: opt("ADMIN_API_TOKEN"),
  customerAuthMode: opt("CUSTOMER_AUTH_MODE", "anonymous") as "anonymous" | "external_jwt",
  externalJwtPublicKey: opt("EXTERNAL_JWT_PUBLIC_KEY"),

  // A conversation lasts this long from the customer's FIRST message (fixed window, later messages don't extend it).
  // Then it closes (transcript kept) and a returning visitor starts a fresh chat. May be fractional (tests use 0.003).
  sessionTtlHours: Number(opt("SESSION_TTL_HOURS", "24")),
  sessionSweepSeconds: Number(opt("SESSION_SWEEP_SECONDS", "60")), // how often expired conversations are closed
  // Delete the transcripts of closed conversations after this many days (0 = keep them).
  transcriptRetentionDays: Number(opt("TRANSCRIPT_RETENTION_DAYS", "0")),

  // LiveKit: `livekitUrl` is what the backend calls (http/https); `livekitPublicUrl` is handed to browsers (ws/wss).
  livekitUrl: req("LIVEKIT_URL"),
  livekitPublicUrl: req("LIVEKIT_PUBLIC_URL"),
  livekitApiKey: req("LIVEKIT_API_KEY"),
  livekitApiSecret: req("LIVEKIT_API_SECRET"),
  // Whether participants may publish microphone / camera tracks. Text chat works with both off.
  enableVoice: opt("ENABLE_VOICE", "false") === "true",
  enableVideo: opt("ENABLE_VIDEO", "false") === "true",
};
