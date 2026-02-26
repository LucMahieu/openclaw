import { Container, Text } from "@mariozechner/pi-tui";
import { TOOL_BULLETS, type ToolBarBulletStyle } from "../../agents/tool-bullets.js";
import { resolveToolBarStatus } from "../../agents/tool-display.js";
import { theme } from "../theme/theme.js";

export type { ToolBarBulletStyle };

export class ToolExecutionComponent extends Container {
  private line: Text;
  private toolName: string;
  private args: unknown;
  private isError = false;
  private isPartial = true;
  private bulletStyle: ToolBarBulletStyle;

  constructor(toolName: string, args: unknown, bulletStyle: ToolBarBulletStyle = "checkboxes") {
    super();
    this.toolName = toolName;
    this.args = args;
    this.bulletStyle = bulletStyle;
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
    const bullets = TOOL_BULLETS[this.bulletStyle];
    const bulletChar = this.isPartial
      ? bullets.running
      : this.isError
        ? bullets.error
        : bullets.done;
    const bulletFn = this.isPartial
      ? theme.toolBarBulletRunning
      : this.isError
        ? theme.toolBarBulletError
        : theme.toolBarBulletDone;
    const bullet = bulletFn(bulletChar);
    const statusText = theme.dim(status);
    this.line.setText(`${bullet}${statusText}`);
  }
}
