import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConversationView } from "./ConversationView";
import { axe } from "./test/axe";

const mockApi = jest.fn();
const mockConv: any = {};

jest.mock("./api", () => ({ BACKEND_URL: "http://backend", api: (...a: unknown[]) => mockApi(...a) }));
jest.mock("./useConversation", () => ({ useConversation: () => mockConv }));

const customer = { name: "Priya", email: "p@x.com", phone: "123", metadata: { plan: "pro" } };
const preview = {
  status: "waiting", mine: false, reason: "Refund", summary: "Wants money back", customer,
  messages: [{ id: "1", role: "customer", name: null, kind: "text", internal: false, body: "Hi", at: "" }],
};
const join = { customer, reason: "Refund", summary: "Wants money back", livekitUrl: "ws://x", livekitToken: "t", features: { voice: true, video: true } };

beforeEach(() => {
  mockApi.mockImplementation(async (_t: string, method: string) => (method === "POST" ? join : preview));
  Object.assign(mockConv, {
    lines: [], typing: false, status: "assigned", connected: true, error: null, send: jest.fn(),
    micOn: false, camOn: false, toggleMic: jest.fn(), toggleCam: jest.fn(), remoteVideo: null, localVideo: null,
  });
});

const view = () => render(<ConversationView token="t" conversationId="c1" online onClose={() => {}} onDecline={() => {}} />);

describe("ConversationView (preview) accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = view();
    await screen.findByRole("button", { name: /accept conversation/i });
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exposes the transcript as a labelled, focusable live log", async () => {
    view();
    const log = await screen.findByRole("log", { name: "Conversation messages" });
    expect(log).toHaveAttribute("aria-live", "polite");
    expect(log).toHaveAttribute("tabindex", "0");
    expect(log).toHaveTextContent("Customer:");
  });

  it("has an unambiguous back button", async () => {
    view();
    expect(await screen.findByRole("button", { name: /back to queue/i })).toBeInTheDocument();
  });
});

describe("ConversationView (live room) accessibility", () => {
  async function joined() {
    const user = userEvent.setup();
    const utils = view();
    await user.click(await screen.findByRole("button", { name: /accept conversation/i }));
    await screen.findByLabelText("Reply to the customer");
    return { user, ...utils };
  }

  it("has no axe violations", async () => {
    const { container } = await joined();
    expect(await axe(container)).toHaveNoViolations();
  });

  it("call buttons expose pressed state", async () => {
    mockConv.micOn = true;
    await joined();
    expect(screen.getByRole("button", { name: /mute/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /^video$/i })).toHaveAttribute("aria-pressed", "false");
  });

  it("announces errors with role=alert", async () => {
    mockConv.error = "Lost connection";
    await joined();
    expect(screen.getByRole("alert")).toHaveTextContent("Lost connection");
  });
});
