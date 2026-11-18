import { describe, expect, it } from "vitest";
import { browserAddress, isOwnPage, pageAt, serverOrigin } from "@/main/origins";

describe("serverOrigin", () => {
  it("takes a bare host name as https", () => {
    expect(serverOrigin("quadit.example.com")).toBe("https://quadit.example.com");
    expect(serverOrigin("  quadit.example.com:8443  ")).toBe("https://quadit.example.com:8443");
  });

  it("keeps http for local servers and drops any path, query or fragment", () => {
    expect(serverOrigin("http://127.0.0.1:4780/e2e/my-work?x=1#y")).toBe("http://127.0.0.1:4780");
    expect(serverOrigin("HTTPS://Quadit.Example.com/")).toBe("https://quadit.example.com");
  });

  it("refuses what is not a web server's address", () => {
    for (const text of [
      "",
      "   ",
      "ftp://example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:pw@example.com",
      "http://",
    ]) {
      expect(serverOrigin(text), text).toBeNull();
    }
  });
});

describe("isOwnPage", () => {
  const origin = "https://quadit.example.com";

  it("is true only for exactly that scheme, host and port", () => {
    expect(isOwnPage("https://quadit.example.com/e2e/inbox", origin)).toBe(true);
    expect(isOwnPage("http://quadit.example.com/e2e", origin)).toBe(false);
    expect(isOwnPage("https://quadit.example.com:444/", origin)).toBe(false);
    expect(isOwnPage("https://evil.quadit.example.com/", origin)).toBe(false);
    expect(isOwnPage("https://quadit.example.com.evil.com/", origin)).toBe(false);
    expect(isOwnPage("about:blank", origin)).toBe(false);
    expect(isOwnPage("not a url", origin)).toBe(false);
  });
});

describe("pageAt", () => {
  const origin = "https://quadit.example.com";

  it("joins an absolute path to the origin", () => {
    expect(pageAt(origin, "/e2e/tasks/ABC-1?tab=activity#c4")).toBe(
      "https://quadit.example.com/e2e/tasks/ABC-1?tab=activity#c4",
    );
  });

  it("refuses paths that would leave the origin or are not absolute", () => {
    for (const path of ["//evil.com/x", "/\\evil.com", "https://evil.com/", "e2e/inbox", "", "javascript:alert(1)"]) {
      expect(pageAt(origin, path), path).toBeNull();
    }
  });
});

describe("browserAddress", () => {
  it("passes http and https on and nothing else", () => {
    expect(browserAddress("https://github.com/agrigoryan/quadit")).toBe("https://github.com/agrigoryan/quadit");
    expect(browserAddress("http://example.com")).toBe("http://example.com/");
    for (const url of [
      "file:///Applications",
      "javascript:alert(1)",
      "quadit://open?server=x",
      "smb://share",
      "nonsense",
    ]) {
      expect(browserAddress(url), url).toBeNull();
    }
  });
});
