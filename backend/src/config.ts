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

  // LiveKit: `livekitUrl` is what the backend calls (http/https); `livekitPublicUrl` is handed to browsers (ws/wss).
  livekitUrl: req("LIVEKIT_URL"),
  livekitPublicUrl: req("LIVEKIT_PUBLIC_URL"),
  livekitApiKey: req("LIVEKIT_API_KEY"),
  livekitApiSecret: req("LIVEKIT_API_SECRET"),
  // Whether participants may publish microphone / camera tracks. Text chat works with both off.
  enableVoice: opt("ENABLE_VOICE", "false") === "true",
  enableVideo: opt("ENABLE_VIDEO", "false") === "true",
  // AI voice: a LiveKit Agents worker (voice-agent/) is dispatched into the room when the customer turns on the mic.
  voiceAgentName: opt("VOICE_AGENT_NAME", "support-voice"),
  internalApiToken: opt("INTERNAL_API_TOKEN"), // shared secret between the backend and the voice worker
};
