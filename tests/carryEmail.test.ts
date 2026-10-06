import { afterEach, expect, it, vi } from "vitest";
import { sendCarryNotice } from "../server/utils/email";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("uses the existing Resend delivery with escaped text and no edit or login capability", async () => {
  vi.stubEnv("RESEND_API_KEY", "fake-test-key");
  vi.stubEnv("AUTH_EMAIL_FROM", "Pack <pack@example.com>");
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetch);
  await sendCarryNotice(
    "molly@example.com",
    "<Yuwei>",
    "Big Pine & friends",
    "https://pack.example.com/carry",
  );
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://api.resend.com/emails");
  const payload = JSON.parse(init.body);
  expect(payload.to).toEqual(["molly@example.com"]);
  expect(payload.html).toContain("&lt;Yuwei&gt;");
  expect(payload.html).toContain("Big Pine &amp; friends");
  expect(payload.text).toContain("https://pack.example.com/carry");
  expect(payload.text).not.toContain("/e/");
  expect(payload.text).not.toContain("/auth/callback");
});
it("reports delivery failure so the already-saved request can stay available", async () => {
  vi.stubEnv("RESEND_API_KEY", "fake-test-key");
  vi.stubEnv("AUTH_EMAIL_FROM", "Pack <pack@example.com>");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "" }),
  );
  await expect(
    sendCarryNotice(
      "molly@example.com",
      "Yuwei",
      "Big Pine",
      "https://pack.example.com/carry",
    ),
  ).rejects.toThrow("503");
});
