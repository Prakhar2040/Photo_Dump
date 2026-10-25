import { describe, expect, it } from "vitest";
import { pickBest } from "@/services/api";
import { seedPhotos } from "./fixtures";

const base = seedPhotos()[0]!;
const p = (w: number, size: number, takenAt: string) => ({ ...base, width: w, height: w, sizeBytes: size, takenAt });

describe("pickBest", () => {
  it("prefers highest resolution", () => {
    expect(pickBest([p(100, 9, "2026"), p(200, 1, "2026")])).toBe(1);
  });
  it("then largest file", () => {
    expect(pickBest([p(100, 1, "2026"), p(100, 5, "2026")])).toBe(1);
  });
  it("then earliest date", () => {
    expect(pickBest([p(100, 5, "2026-02"), p(100, 5, "2026-01")])).toBe(1);
  });
});
