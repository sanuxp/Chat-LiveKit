import { AccessToken, DataPacket_Kind, RoomServiceClient, TrackSource } from "livekit-server-sdk";
import { config } from "../config.js";

/**
 * LiveKit is the realtime layer. One conversation = one room (`conv_<id>`).
 *  - Chat events are pushed from the backend as data packets on the "chat" topic (the backend is the only
 *    writer, so clients can't spoof senders). Clients send messages through the REST API.
 *  - Voice/video are plain LiveKit tracks in the same room, enabled by ENABLE_VOICE / ENABLE_VIDEO.
 */

export const CHAT_TOPIC = "chat";
export const roomName = (conversationId: string) => `conv_${conversationId}`;
export const customerIdentity = (customerId: string) => `customer_${customerId}`;
export const agentIdentity = (username: string) => `agent_${username}`;

const rooms = new RoomServiceClient(config.livekitUrl, config.livekitApiKey, config.livekitApiSecret);

export interface WireMessage {
  id: string;
  role: "customer" | "ai" | "agent" | "system";
  name: string | null;
  kind: "text" | "notice";
  internal: boolean;
  body: string;
  at: string;
}

export type ChatEvent =
  | { t: "message"; message: WireMessage }
  | { t: "stream"; id: string; body: string; n: number } // partial AI answer, replaced by the final "message" with the same id
  | { t: "typing"; on: boolean }
  | { t: "state"; status: string; agent: string | null };

/** Push an event to everyone in the conversation's room (or only to `to` identities). Best-effort. */
export async function publish(conversationId: string, event: ChatEvent, to?: string[]): Promise<void> {
  try {
    await rooms.sendData(
      roomName(conversationId),
      new TextEncoder().encode(JSON.stringify(event)),
      DataPacket_Kind.RELIABLE,
      { topic: CHAT_TOPIC, ...(to ? { destinationIdentities: to } : {}) },
    );
  } catch {
    // room doesn't exist yet / nobody connected: the message is already stored and loaded from history
  }
}

export async function removeParticipant(conversationId: string, identity: string): Promise<void> {
  await rooms.removeParticipant(roomName(conversationId), identity).catch(() => {});
}

export async function deleteRoom(conversationId: string): Promise<void> {
  await rooms.deleteRoom(roomName(conversationId)).catch(() => {});
}

export async function mintToken(opts: {
  conversationId: string; identity: string; name: string; role: "customer" | "agent";
}): Promise<string> {
  const canPublish = config.enableVoice || config.enableVideo;
  const sources: TrackSource[] = [];
  if (config.enableVoice) sources.push(TrackSource.MICROPHONE);
  if (config.enableVideo) sources.push(TrackSource.CAMERA);
  const at = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
    identity: opts.identity,
    name: opts.name,
    ttl: "12h",
    metadata: JSON.stringify({ role: opts.role }),
  });
  at.addGrant({
    room: roomName(opts.conversationId),
    roomJoin: true,
    canSubscribe: true,
    canPublish,
    canPublishSources: sources,
    canPublishData: false, // chat goes through the backend
  });
  return at.toJwt();
}
