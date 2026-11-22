import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Queue, type ConversationRow } from "./Queue";
import { axe } from "./test/axe";

const now = new Date().toISOString();
const customer = { name: "Priya", email: "p@x.com", phone: "1", metadata: {} };
const rows: ConversationRow[] = [
  { id: "a", status: "waiting", assignedAgent: null, reason: "Refund", summary: "Wants money back", updatedAt: now, customer },
  { id: "b", status: "assigned", assignedAgent: "me", reason: "Login issue", summary: null, updatedAt: now, customer },
  { id: "c", status: "waiting", assignedAgent: null, reason: "Billing", summary: null, updatedAt: now, customer },
];

describe("Queue accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = render(<Queue rows={rows} declined={new Set(["c"])} canTake onOpen={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("exposes each list as a named region", () => {
    render(<Queue rows={rows} declined={new Set()} canTake onOpen={() => {}} />);
    expect(screen.getByRole("region", { name: /my conversations/i })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: /waiting/i })).toBeInTheDocument();
  });

  it("gives action buttons a name that says which conversation they act on", () => {
    render(<Queue rows={rows} declined={new Set()} canTake onOpen={() => {}} />);
    const waiting = screen.getByRole("region", { name: /waiting/i });
    expect(within(waiting).getByRole("button", { name: /review conversation with priya: refund/i })).toBeInTheDocument();
  });

  it("the show-declined toggle reports its expanded state", async () => {
    const user = userEvent.setup();
    render(<Queue rows={rows} declined={new Set(["c"])} canTake onOpen={() => {}} />);
    const toggle = screen.getByRole("button", { name: "Show" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Hide" })).toHaveAttribute("aria-expanded", "true");
  });

  it("opens a conversation from the keyboard", async () => {
    const onOpen = jest.fn();
    const user = userEvent.setup();
    render(<Queue rows={rows} declined={new Set()} canTake onOpen={onOpen} />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(onOpen).toHaveBeenCalledWith("b");
  });
});
