export type ToolBarBulletStyle = "circles" | "checkboxes";

export const TOOL_BULLETS: Record<
  ToolBarBulletStyle,
  { running: string; done: string; error: string }
> = {
  circles: { running: "○ ", done: "● ", error: "● " },
  checkboxes: { running: "□ ", done: "✓ ", error: "✗ " },
};
