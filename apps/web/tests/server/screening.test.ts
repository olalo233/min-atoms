import { afterEach, describe, expect, test, vi } from "vitest";
import { screenInput, ScreeningUnavailable, type ScreeningFetch } from "@/lib/server/screening";

const input = { kind: "message", content: "做一个正常登录表单" } as const;
const annotation = { route: "/settings", tag: "button", text: "保存", selector: "#save", rect: { x: 0, y: 0, w: 10, h: 10 } };
function answer(harmful = 0.01, attack = 0.02, category = "benign") {
  return new Response(JSON.stringify({ answers: {
    harmful_app: { type: "noul", noul: harmful }, platform_attack: { type: "noul", noul: attack },
    category: { type: "choice", choice: category },
  } }));
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("Jev input screening", () => {
  test("allows normal requests and sends the official questions, state and criteria map", async () => {
    const fetch = vi.fn<ScreeningFetch>(async () => answer());
    expect(await screenInput({ ...input, annotation }, { key: "fake-key", fetch })).toMatchObject({ verdict: "allow", category: "benign" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(init.headers).toMatchObject({ authorization: "Bearer fake-key" });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "jev-latest", state: { request: input.content, annotation, platform: "受邀用户用自然语言让 AI 生成并运行小型全栈 Web 应用的演示平台" } });
    expect(Object.keys(body.questions)).toEqual(["harmful_app", "platform_attack", "category"]);
    expect(body.questions.category.criteria).toMatchObject({ benign: "正常需求", prompt_injection: "操纵 AI 规则" });
    expect(Array.isArray(body.questions.category.criteria)).toBe(false);
  });

  test.each([[0.85, 0], [0, 0.85]])("blocks either score at the threshold (%s, %s)", async (harm, attack) => {
    expect(await screenInput(input, { key: "fake-key", fetch: async () => answer(harm, attack) })).toMatchObject({ verdict: "block" });
  });
  test("category only records intent and threshold is configurable", async () => {
    vi.stubEnv("MA_SCREEN_THRESHOLD", "0.9");
    expect(await screenInput(input, { key: "fake-key", fetch: async () => answer(0.86, 0, "phishing") })).toMatchObject({ verdict: "allow", category: "phishing" });
  });
  test("missing key is unavailable without a fetch", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const fetch = vi.fn();
    await expect(screenInput(input, { fetch })).rejects.toBeInstanceOf(ScreeningUnavailable);
    expect(fetch).not.toHaveBeenCalled();
  });
  test.each([401, 422, 500, 503])("HTTP %s rejects without retry", async (status) => {
    const fetch = vi.fn(async () => new Response("", { status }));
    await expect(screenInput(input, { key: "fake-key", fetch })).rejects.toBeInstanceOf(ScreeningUnavailable);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  test.each([429, 529])("HTTP %s retries once with backoff inside the total budget", async (status) => {
    vi.useFakeTimers();
    const fetch = vi.fn<ScreeningFetch>().mockResolvedValueOnce(new Response("", { status })).mockImplementationOnce(async () => answer());
    const pending = screenInput(input, { key: "fake-key", fetch });
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toMatchObject({ verdict: "allow" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test("a second overload is unavailable without a third request", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response("", { status: 429 }));
    const assertion = expect(screenInput(input, { key: "fake-key", fetch })).rejects.toBeInstanceOf(ScreeningUnavailable);
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test("the three second deadline covers a hanging fetch even if it ignores abort", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<ScreeningFetch>(() => new Promise(() => {}));
    const assertion = expect(screenInput(input, { key: "fake-key", fetch })).rejects.toBeInstanceOf(ScreeningUnavailable);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(fetch.mock.calls[0][1].signal?.aborted).toBe(true);
  });
  test("retry and body consumption share the original deadline", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn<ScreeningFetch>().mockResolvedValueOnce(new Response("", { status: 529 }))
      .mockResolvedValueOnce(new Response(new ReadableStream({ start() {} })));
    const assertion = expect(screenInput(input, { key: "fake-key", fetch })).rejects.toBeInstanceOf(ScreeningUnavailable);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  test("network failures and invalid answers are unavailable", async () => {
    for (const fetch of [async () => { throw new Error("network"); }, async () => new Response('{}'), async () => answer(1.1), async () => answer(0, 0, "unknown")]) {
      await expect(screenInput(input, { key: "fake-key", fetch })).rejects.toBeInstanceOf(ScreeningUnavailable);
    }
  });
});
