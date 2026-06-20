import { parseBridgeCommand, parseWorkspaceCommand } from "../utils/commands.js";
import { parseMemoryCommand } from "../memory/memory-commands.js";

export interface CommandRouterResult {
  isImmediate: boolean;
  skipFlush: boolean;
}

export class CommandRouter {
  classify(text: string): CommandRouterResult {
    const trimmed = text.trim();
    const bridgeCmd = parseBridgeCommand(trimmed);
    const isImmediate = Boolean(
      bridgeCmd ||
      parseWorkspaceCommand(trimmed) ||
      parseMemoryCommand(trimmed),
    );
    return {
      isImmediate,
      skipFlush: bridgeCmd === "cancel",
    };
  }
}
