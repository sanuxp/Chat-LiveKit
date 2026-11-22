import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ChatWidget } from "./ChatWidget";
import { axe } from "./test/axe";

const mockCreateSession = jest.fn();
const mockConv: any = {};

jest.mock("./api", () => ({
  createSession: (...a: unknown[]) => mockCreateSession(...a),
  deleteConversation: jest.fn(async () => {}),
}));
jest.mock("./useConversation", () => ({ useConversation: () => mockConv }));

const session = {
  conversationId: "c1", status: "ai", livekitUrl: "ws://x", livekitToken: "t", backendToken: "b",
  features: { voice: true, video: true }, profile: { name: "A", email: "a@x", phone: "1" },
};
const opts = { backendUrl: "http://backend", user: { email: "a@x" } };

beforeEach(() => {
  mockCreateSession.mockResolvedValue(session);
  Object.assign(mockConv, {
    lines: [
      { id: "1", role: "customer", name: null, kind: "text", internal: false, body: "Hello there", at: "" },
      { id: "2", role: "ai", name: null, kind: "text", internal: false, body: "How can I help?", at: "" },
      { id: "3", role: "agent", name: "Priya", kind: "text", internal: false, body: "Joining now", at: "" },
    ],
    typing: false, status: "ai", agent: null, connected: true, error: null, setError: jest.fn(),
    send: jest.fn(async () => {}), micOn: false, camOn: false, toggleMic: jest.fn(), toggleCam: jest.fn(),
    remoteVideo: null, localVideo: null, assistantOn: false,
  });
});

async function openChat() {
  const user = userEvent.setup();
  render(<ChatWidget opts={opts} />);
  await user.click(screen.getByRole("button", { name: /open support chat/i }));
  await screen.findByRole("log", { name: "Messages" });
  return user;
}

describe("ChatWidget accessibility", () => {
  it("has no axe violations when open", async () => {
    const { container } = render(<ChatWidget opts={opts} />);
    await userEvent.setup().click(screen.getByRole("button", { name: /open support chat/i }));
    await screen.findByRole("log", { name: "Messages" });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("launcher reports expanded state and the popup", async () => {
    const user = await openChat();
    const trigger = screen.getByRole("button", { name: /close support chat/i });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(user).toBeDefined();
  });

  it("names the dialog and moves focus to the message field", async () => {
    await openChat();
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Support chat");
    await waitFor(() => expect(screen.getByLabelText("Message")).toHaveFocus());
  });

  it("closes on Escape and returns focus to the launcher", async () => {
    const user = await openChat();
    await user.keyboard("{Escape}");
    const trigger = screen.getByRole("button", { name: /open support chat/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("delete confirmation is an alertdialog that takes focus; Escape cancels only it", async () => {
    const user = await openChat();
    await user.click(screen.getByRole("button", { name: "Delete conversation" }));
    expect(screen.getByRole("alertdialog", { name: "Confirm delete" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close support chat/i })).toHaveAttribute("aria-expanded", "true");
  });

  it("tells screen reader users who wrote each message", async () => {
    await openChat();
    const log = screen.getByRole("log", { name: "Messages" });
    expect(log).toHaveTextContent("You: Hello there");
    expect(log).toHaveTextContent("Assistant: How can I help?");
    expect(log).toHaveTextContent("Priya");
  });

  it("announces typing as a status, not letter by letter", async () => {
    mockConv.typing = true;
    await openChat();
    expect(screen.getByRole("status")).toHaveTextContent("Support is typing");
  });

  it("does not expose half-streamed AI text to assistive tech", async () => {
    mockConv.lines = [{ id: "9", role: "ai", name: null, kind: "text", internal: false, body: "Partial answ", at: "", streaming: true }];
    await openChat();
    const log = screen.getByRole("log", { name: "Messages" });
    expect(log.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(log.querySelector(".sc-sr:not(:empty)")?.textContent ?? "").not.toContain("Partial answ");
  });

  it("call buttons expose pressed state", async () => {
    mockConv.micOn = true;
    await openChat();
    expect(screen.getByRole("button", { name: "Mute microphone" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Turn on camera" })).toHaveAttribute("aria-pressed", "false");
  });

  it("announces connection failures with role=alert", async () => {
    mockCreateSession.mockRejectedValueOnce(new Error("down"));
    const user = userEvent.setup();
    render(<ChatWidget opts={opts} />);
    await user.click(screen.getByRole("button", { name: /open support chat/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not connect/i);
  });
});
