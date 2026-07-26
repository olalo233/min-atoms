import { afterEach, describe, expect, it, vi } from "vitest";

import { deepSeekProvider } from "@/lib/generation/deepseek";

describe("DeepSeek artifact contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("requires self-contained code compatible with the preview smoke runtime", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  "app.js": "",
                  "index.html": "",
                  "manifest.json": "{}",
                  "styles.css": "",
                }),
              },
            },
          ],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await deepSeekProvider.generate({
      baseArtifact: null,
      buildRequest: "Render profile and blog Markdown.",
    });

    const request = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ content: string; role: string }> };
    const instruction = request.messages.find(
      (message) => message.role === "user",
    )?.content;

    expect(instruction).toContain("fully self-contained");
    expect(instruction).toContain("Do not rely on undeclared globals");
    expect(instruction).toContain("Markdown");
    expect(instruction).toContain("without external libraries");
  });
});
