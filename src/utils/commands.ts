export type BridgeCommand =
  | "ping"
  | "help"
  | "status"
  | "usage"
  | "confirm"
  | "cancel";

export type WorkspaceCommand =
  | { type: "clear-conversation" }
  | { type: "new-conversation" }
  | { type: "list-conversations" }
  | { type: "select-conversation"; index: number }
  | { type: "current-persona" }
  | { type: "list-personas" }
  | { type: "select-persona"; index: number };

export function parseBridgeCommand(text: string): BridgeCommand | undefined {
  switch (text.trim().toLowerCase()) {
    case "/ping":
    case "/测试":
    case "/连通测试":
      return "ping";
    case "/help":
    case "/帮助":
      return "help";
    case "/status":
    case "/状态":
      return "status";
    case "/usage":
    case "/查询额度":
    case "/额度":
      return "usage";
    case "/confirm":
    case "/确认":
      return "confirm";
    case "/cancel":
    case "/取消":
      return "cancel";
    default:
      return undefined;
  }
}

export function parseWorkspaceCommand(text: string): WorkspaceCommand | undefined {
  const command = text.trim();
  if (command === "/清空对话") return { type: "clear-conversation" };
  if (command === "/新对话") return { type: "new-conversation" };
  if (command === "/查看对话") return { type: "list-conversations" };
  if (command === "/查看当前人设") return { type: "current-persona" };
  if (command === "/查看人设" || command === "/查看人设列表") return { type: "list-personas" };

  const conversation = command.match(/^\/切换对话(?:\s*\+?\s*)(\d{1,3})$/u);
  if (conversation) return { type: "select-conversation", index: Number(conversation[1]) };
  const persona = command.match(/^\/切换人设(?:\s*\+?\s*)(\d{1,3})$/u);
  if (persona) return { type: "select-persona", index: Number(persona[1]) };
  return undefined;
}
