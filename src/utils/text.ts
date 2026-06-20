export function chunkText(text: string, maxLength: number): string[] {
  if (!Number.isInteger(maxLength) || maxLength <= 0) {
    throw new Error("maxLength must be a positive integer");
  }
  if (text.length === 0) return [""];

  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxLength) {
    chunks.push(text.slice(offset, offset + maxLength));
  }
  return chunks;
}

export function chunkReplyText(
  text: string,
  maxLength: number,
  sentencesPerMessage = 2,
): string[] {
  if (!Number.isInteger(sentencesPerMessage) || sentencesPerMessage <= 0) {
    throw new Error("sentencesPerMessage must be a positive integer");
  }
  if (text.length === 0) return [""];

  const messages: string[] = [];
  const paragraphs = text.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    const isStructuredBlock = paragraph.includes("\n") || paragraph.includes("```");
    const groups = isStructuredBlock
      ? [paragraph]
      : groupSentences(splitSentences(paragraph), sentencesPerMessage);
    for (const group of groups) {
      messages.push(...chunkText(group, maxLength));
    }
  }
  return messages.length > 0 ? messages : [text];
}

function splitSentences(text: string): string[] {
  return text.match(/[^。！？!?]+[。！？!?]+(?:[”’」』】）)]*)?|[^。！？!?]+$/gu)?.map((part) => part.trim()).filter(Boolean)
    ?? [text];
}

function groupSentences(sentences: string[], groupSize: number): string[] {
  const groups: string[] = [];
  for (let index = 0; index < sentences.length; index += groupSize) {
    groups.push(sentences.slice(index, index + groupSize).join(""));
  }
  return groups;
}
