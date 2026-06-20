import { describe, expect, it } from "vitest";
import { chunkReplyText, chunkText } from "../src/utils/text.js";

describe("chunkText", () => {
  it("splits long text without losing content", () => {
    const source = "abcdefghij";
    const chunks = chunkText(source, 4);
    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
    expect(chunks.join("")).toBe(source);
  });
});

describe("chunkReplyText", () => {
  it("groups a normal reply into two sentences per QQ message", () => {
    expect(chunkReplyText("第一句。第二句！第三句？第四句。第五句。", 1_500, 2)).toEqual([
      "第一句。第二句！",
      "第三句？第四句。",
      "第五句。",
    ]);
  });

  it("keeps multiline command lists together", () => {
    const source = "/查看当前人设：查看当前窗口\n/查看人设列表：查看全部人设";
    expect(chunkReplyText(source, 1_500, 2)).toEqual([source]);
  });

  it("still enforces the maximum OneBot message length", () => {
    expect(chunkReplyText("abcdefghij", 4, 2)).toEqual(["abcd", "efgh", "ij"]);
  });
});
