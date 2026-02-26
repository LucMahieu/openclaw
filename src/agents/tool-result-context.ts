import { AsyncLocalStorage } from "node:async_hooks";

export type ToolResultContext = {
  toolCallId: string;
};

const toolResultContextStore = new AsyncLocalStorage<ToolResultContext>();

export function runWithToolResultContext<T>(context: ToolResultContext, run: () => T): T {
  return toolResultContextStore.run(context, run);
}

export function getToolResultContext(): ToolResultContext | undefined {
  return toolResultContextStore.getStore();
}
