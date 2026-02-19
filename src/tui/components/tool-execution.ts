import { Container, Text } from "@mariozechner/pi-tui";
import { resolveToolBarStatus } from "../../agents/tool-display.js";
import { theme } from "../theme/theme.js";

const BULLET = "• ";

export class ToolExecutionComponent extends Container {
  private line: Text;
  private toolName: string;
  private args: unknown;
  private isError = false;
  private isPartial = true;

  constructor(toolName: string, args: unknown) {
    super();
    this.toolName = toolName;
    this.args = args;
    this.line = new Text("", 0, 0);
    this.addChild(this.line);
    this.refresh();
  }

  setArgs(args: unknown) {
    this.args = args;
    this.refresh();
  }

  setExpanded(_expanded: boolean) {
    // No-op: CUA-style bar has no expand/collapse
  }

  setResult(_result: unknown, opts?: { isError?: boolean }) {
    this.isPartial = false;
    this.isError = Boolean(opts?.isError);
    this.refresh();
  }

  setPartialResult(_result: unknown) {
    this.isPartial = true;
    this.refresh();
  }

  private refresh() {
    const status = resolveToolBarStatus({
      name: this.toolName,
      args: this.args,
      isPartial: this.isPartial,
      isError: this.isError,
    });
    const bulletFn = this.isPartial
      ? theme.toolBarBulletRunning
      : this.isError
        ? theme.toolBarBulletError
        : theme.toolBarBulletDone;
    const bullet = bulletFn(BULLET);
    const statusText = theme.dim(status);
    this.line.setText(`${bullet}${statusText}`);
  }
}
