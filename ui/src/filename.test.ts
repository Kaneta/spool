// fixture 読み込みは node runtime の readFileSync (bundler の JSON import magic には依存しない)。
// @ts-expect-error -- @types/node を依存に追加しないため型解決を抑制する。実行時は vitest node runtime。
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  candidateName,
  capturedAtIso,
  capturedAtPrefix,
  deriveTitle,
  isNameWithinLimit,
  isValidRootDirectChildName,
  validateGeneratedFilename,
} from "./filename";

// fixture は TS / Go 共有 (Go: pc/internal/namegen/namegen_test.go)。
const vectors = JSON.parse(
  readFileSync(new URL("../../test/vectors/filename.json", import.meta.url), "utf8"),
) as {
  titleCases: { text: string; want: string }[];
  nameBuildingCases: { prefix: string; title: string; suffix: number; name: string; withinLimit: boolean }[];
  generatedFilenameCases: { name: string; captured: boolean }[];
  rootDirectChildCases: { name: string; safe: boolean }[];
  capturedAtGenerationCases: {
    invalid?: boolean;
    year?: number;
    month?: number;
    day?: number;
    hour?: number;
    minute?: number;
    iso: string | null;
    prefix: string | null;
  }[];
  titleRoundTripCases: { prefix: string; text: string }[];
};

// DESIGN-v2 §3.4 title 導出 (共有 fixture)
for (const [i, c] of vectors.titleCases.entries()) {
  it(`deriveTitle ${i}`, () => {
    expect(deriveTitle(c.text)).toBe(c.want);
  });
}

// §3.5 candidate name と 255 byte 上限 (共有 fixture)
for (const [i, c] of vectors.nameBuildingCases.entries()) {
  it(`candidateName ${i}`, () => {
    const name = candidateName(c.prefix, c.title, c.suffix);
    expect(name).toBe(c.name);
    expect(isNameWithinLimit(name)).toBe(c.withinLimit);
  });
}

// §3.6 生成規則の完全検証 (共有 fixture)
for (const [i, c] of vectors.generatedFilenameCases.entries()) {
  it(`validateGeneratedFilename ${i}`, () => {
    expect(validateGeneratedFilename(c.name)).toBe(c.captured);
  });
}

// §3.6 分類整合: captured と判定される name は常に safe root-direct-child でもある
it("captured cases are safe root-direct-child names", () => {
  for (const c of vectors.generatedFilenameCases) {
    if (c.captured) expect(isValidRootDirectChildName(c.name)).toBe(true);
  }
});

// §6.4 safe root-direct-child name (共有 fixture)
for (const [i, c] of vectors.rootDirectChildCases.entries()) {
  it(`isValidRootDirectChildName ${i}`, () => {
    expect(isValidRootDirectChildName(c.name)).toBe(c.safe);
  });
}

// §3.3 / §6.4: Browser 側の captured_at 生成 (Date local fields → ISO minute → prefix)。
// 拒否系 (暦不正) は Go 側 parse の責務であり、TS では Date parser 拒否 test を作らない。
for (const [i, c] of vectors.capturedAtGenerationCases.entries()) {
  it(`capturedAtIso ${i}`, () => {
    if (c.invalid) {
      expect(capturedAtIso(new Date(NaN))).toBeNull();
      return;
    }
    const d = new Date(c.year!, c.month! - 1, c.day!, c.hour!, c.minute!);
    expect(capturedAtIso(d)).toBe(c.iso);
    expect(capturedAtPrefix(d)).toBe(c.prefix);
  });
}

// §3.6 生成 → 検証の閉包: deriveTitle 出力は suffix 0 の candidate として必ず validate を通る
// (byte limit 超過で candidate が生成不可になる case は fixture に含めない)
for (const [i, c] of vectors.titleRoundTripCases.entries()) {
  it(`title roundtrip ${i}`, () => {
    const name = candidateName(c.prefix, deriveTitle(c.text), 0);
    expect(validateGeneratedFilename(name)).toBe(true);
  });
}
