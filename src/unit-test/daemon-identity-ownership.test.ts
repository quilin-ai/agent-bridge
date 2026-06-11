import { describe, expect, test } from "bun:test";
import { pidFileOwnedByUs } from "../daemon-identity-ownership";

describe("daemon-identity-ownership — pidFileOwnedByUs", () => {
  test("returns true only when the pid in the file equals our pid", () => {
    const read = () => "4242\n";
    expect(pidFileOwnedByUs("/x/daemon.pid", 4242, read)).toBe(true);
  });

  test("returns false when the file holds a DIFFERENT pid (losing D2 must not wipe D1)", () => {
    // D1 (the live incumbent) owns the file with pid 1111; D2 (us, pid 2222)
    // lost the bind race — it must treat the shared file as not-ours.
    const read = () => "1111\n";
    expect(pidFileOwnedByUs("/x/daemon.pid", 2222, read)).toBe(false);
  });

  test("tolerates trailing/leading whitespace around the pid", () => {
    expect(pidFileOwnedByUs("/x/daemon.pid", 77, () => "  77 \n")).toBe(true);
  });

  test("returns false when the file is unreadable (no file / IO error)", () => {
    const read = () => {
      throw new Error("ENOENT");
    };
    expect(pidFileOwnedByUs("/x/daemon.pid", 4242, read)).toBe(false);
  });

  test("returns false when the file content is not a finite integer", () => {
    expect(pidFileOwnedByUs("/x/daemon.pid", 4242, () => "not-a-pid")).toBe(false);
    expect(pidFileOwnedByUs("/x/daemon.pid", 4242, () => "")).toBe(false);
    expect(pidFileOwnedByUs("/x/daemon.pid", 4242, () => "NaN")).toBe(false);
  });

  test("matches on exact integer equality, not numeric coercion of garbage", () => {
    // "4242abc" parses to 4242 via parseInt, but we require a clean integer.
    expect(pidFileOwnedByUs("/x/daemon.pid", 4242, () => "4242abc")).toBe(false);
  });
});
