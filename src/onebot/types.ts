export interface OneBotPrivateMessageEvent {
  time: number;
  self_id: number;
  post_type: "message";
  message_type: "private";
  sub_type: string;
  message_id: number;
  user_id: number;
  sender?: {
    user_id?: number | string;
  };
  message: unknown;
  raw_message: string;
}

export function isPrivateMessageEvent(value: unknown): value is OneBotPrivateMessageEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Record<string, unknown>;
  return (
    event.post_type === "message" &&
    event.message_type === "private" &&
    typeof event.user_id === "number" &&
    typeof event.message_id === "number"
  );
}

export function isAllowedPrivateMessageEvent(
  value: unknown,
  allowedUserId: number,
): boolean {
  return isPrivateMessageEvent(value) && value.user_id === allowedUserId;
}
