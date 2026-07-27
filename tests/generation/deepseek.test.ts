import { afterEach, describe, expect, it, vi } from "vitest";

import { deepSeekProvider } from "@/lib/generation/deepseek";

describe("DeepSeek artifact contract", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DEEPSEEK_API_KEY;
  });

  it("requires self-contained code compatible with the real browser Preview", async () => {
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

    expect(instruction).toContain("Use normal semantic HTML");
    expect(instruction).toContain("Preview sandbox and Content Security Policy");
    expect(instruction).toContain("Do not weaken the requested product");
    expect(instruction).toContain("Do not rely on undeclared globals");
    expect(instruction).toContain("Markdown");
    expect(instruction).toContain("without external libraries");
    expect(instruction).toContain("Canvas 2D");
    expect(instruction).toContain("requestAnimationFrame");
    expect(instruction).toContain("keyboard, pointer, and touch events");
    expect(instruction).toContain("reports real browser errors");
    expect(instruction).toContain("pico-2");
    expect(instruction).toContain("bootstrap-5");
    expect(instruction).toContain("one signature element");
    expect(instruction).toContain("platform loads the preset stylesheet");
    expect(instruction).toContain("never add link or script tags");
    expect(instruction).toContain("expression must be exactly 7+1");
    expect(instruction).toContain("legacy smoke object is allowed but optional");
  });

  it("requires a repair response to change the rejected candidate", async () => {
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

    await deepSeekProvider.repair?.(
      { baseArtifact: null, buildRequest: "Build a calculator" },
      { rejected: true },
      "Artifact smoke click #calculate did not update #result.",
    );

    const request = JSON.parse(
      String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
    ) as { messages: Array<{ content: string; role: string }> };
    const instruction = request.messages.find(
      (message) => message.role === "user",
    )?.content;
    expect(instruction).toContain("Do not return the candidate unchanged");
    expect(instruction).toContain("repair every inconsistent part");
    expect(instruction).toContain("Calculate, Evaluate, or Equals");
    expect(instruction).toContain(
      "a keypad sequence may use digit and operator controls",
    );
    expect(instruction).toContain(
      "the exact variable evaluated by Equals must contain 7+1",
    );
    expect(instruction).toContain("#calculate");
    expect(instruction).toContain("#result");
    expect(instruction).toContain('"op":"replace-file"');
    expect(instruction).toContain("compare every replacement byte-for-byte");
    expect(instruction).toContain("at least one file actually changes");
    expect(instruction).not.toContain(
      "Return only a JSON object with exactly these string keys",
    );
  });

  it("returns one usable provider response without an in-invocation retry", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const artifact = {
      "app.js": "",
      "index.html": "",
      "manifest.json": "{}",
      "styles.css": "",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(artifact) } }],
          }),
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deepSeekProvider.generate({
        baseArtifact: null,
        buildRequest: "Build a calculator",
      }),
    ).resolves.toEqual(artifact);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a provider error for persistence by the next durable step", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "not json" } }] }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      deepSeekProvider.generate({
        baseArtifact: null,
        buildRequest: "Build a calculator",
      }),
    ).rejects.toThrow("provider_invalid_response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
