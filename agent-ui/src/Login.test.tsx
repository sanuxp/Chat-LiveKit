import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Login } from "./Login";
import { axe } from "./test/axe";

describe("Login accessibility", () => {
  it("has no axe violations", async () => {
    const { container } = render(<Login onLogin={async () => {}} error={null} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("has no axe violations with an error shown", async () => {
    const { container } = render(<Login onLogin={async () => {}} error="Sign-in failed." />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("labels both fields and exposes a main landmark", () => {
    render(<Login onLogin={async () => {}} error={null} />);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeRequired();
    expect(screen.getByLabelText("Password")).toBeRequired();
  });

  it("announces the error and links it to the password field", () => {
    render(<Login onLogin={async () => {}} error="Sign-in failed." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in failed.");
    expect(screen.getByLabelText("Password")).toHaveAccessibleDescription("Sign-in failed.");
  });

  it("is operable by keyboard alone", async () => {
    const onLogin = jest.fn(async () => {});
    const user = userEvent.setup();
    render(<Login onLogin={onLogin} error={null} />);
    expect(screen.getByLabelText("Username")).toHaveFocus(); // autofocus
    await user.keyboard("alice{Tab}secret{Enter}");
    expect(onLogin).toHaveBeenCalledWith("alice", "secret");
  });
});
