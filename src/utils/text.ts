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
): string[] {
  if (text.length === 0) return [""];

  const messages: string[] = [];
  const paragraphs = text.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  for (const paragraph of paragraphs) {
    messages.push(...chunkText(paragraph, maxLength));
  }
  return messages.length > 0 ? messages : [text];
}
