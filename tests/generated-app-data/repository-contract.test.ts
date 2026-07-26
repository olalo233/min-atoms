import { describe, expect, it } from "vitest";

import { isBoundedGeneratedAppDataValue } from "@/lib/generated-app-data/contract";

describe("Generated App Data persistence contract", () => {
  it("keeps JSON null as a valid persisted value", () => {
    expect(isBoundedGeneratedAppDataValue(null)).toBe(true);
  });
});
