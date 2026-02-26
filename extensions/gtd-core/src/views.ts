import type { GtdState } from "./schema.js";

function fmtTs(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) {
    return "-";
  }
  return new Date(ts).toISOString();
}

function section(title: string, lines: string[]): string {
  return [`# ${title}`, "", ...(lines.length > 0 ? lines : ["- (none)"]), ""].join("\n");
}

function renderInbox(state: GtdState): string {
  const lines = state.inboxItems.map(
    (item) =>
      `- [${item.status}] ${item.rawText.replace(/\n+/g, " ")}  \n  id=${item.id} captured=${fmtTs(item.capturedAtMs)} source=${item.source}`,
  );
  return section("Inbox", lines);
}

function renderNextActions(state: GtdState): string {
  const lines = state.actions
    .filter((item) => item.status === "active")
    .map(
      (item) =>
        `- ${item.textVerbFirst}  \n  id=${item.id} context=${item.context} energy=${item.energy} estimate=${item.estimateMin}m due=${fmtTs(item.dueAtMs)}`,
    );
  return section("Next Actions", lines);
}

function renderProjects(state: GtdState): string {
  const lines = state.projects.map(
    (project) =>
      `- [${project.status}] ${project.outcome}  \n  id=${project.id} next=${project.nextActionId ?? "-"} area=${project.areaId ?? "-"} goal=${project.goalId ?? "-"}`,
  );
  return section("Projects", lines);
}

function renderWaitingFor(state: GtdState): string {
  const lines = state.waitingFor.map(
    (item) =>
      `- [${item.status}] ${item.who}: ${item.what}  \n  id=${item.id} followup=${fmtTs(item.followupAtMs)} cadence=${item.followupCadenceDays}d target=${item.deliveryTarget?.channel ?? "-"}:${item.deliveryTarget?.to ?? "-"}`,
  );
  return section("Waiting For", lines);
}

function renderCalendar(state: GtdState): string {
  const lines = state.calendarItems
    .filter((item) => item.hardLandscape)
    .map(
      (item) =>
        `- ${item.title}  \n  id=${item.id} ${fmtTs(item.startMs)} -> ${fmtTs(item.endMs)} allDay=${item.allDay} source=${item.source}`,
    );
  return section("Calendar Hard Landscape", lines);
}

function renderSomeday(state: GtdState): string {
  const lines = state.somedayMaybe.map(
    (item) =>
      `- [${item.status}] ${item.title}  \n  id=${item.id} reviewAfter=${fmtTs(item.reviewAfterMs)} reason=${item.reason ?? "-"}`,
  );
  return section("Someday Maybe", lines);
}

function renderHorizons(state: GtdState): string {
  const lines: string[] = [];
  lines.push(`- Purpose: ${state.horizons.purpose ?? "-"}`);
  lines.push(`- Vision: ${state.horizons.vision ?? "-"}`);
  lines.push("- Goals:");
  if (state.horizons.goals.length === 0) {
    lines.push("- (none)");
  } else {
    for (const goal of state.horizons.goals) {
      lines.push(`- ${goal.id}: ${goal.title}`);
    }
  }
  lines.push("- Areas:");
  if (state.horizons.areas.length === 0) {
    lines.push("- (none)");
  } else {
    for (const area of state.horizons.areas) {
      lines.push(`- ${area.id}: ${area.title}`);
    }
  }
  return section("Horizons", lines);
}

function renderReviews(state: GtdState): string {
  const lines = state.reviews.runs
    .slice(-50)
    .toReversed()
    .map(
      (run) =>
        `- ${run.kind} @ ${fmtTs(run.runAtMs)}  \n  id=${run.id}${run.notes.length > 0 ? ` notes=${run.notes.join(" | ")}` : ""}`,
    );
  return section("Reviews", lines);
}

function renderCommitments(state: GtdState): string {
  const lines = state.commitments
    .toReversed()
    .slice(0, 100)
    .map(
      (item) =>
        `- [${item.decision}] request=${item.requestRef} owner=${item.owner}  \n  id=${item.id} nextUpdate=${fmtTs(item.nextUpdateAtMs)} session=${item.sessionKey ?? "-"}`,
    );
  return section("Commitments", lines);
}

function renderDashboard(params: { agentId: string; state: GtdState }): string {
  const { state, agentId } = params;
  const lines = [
    `- Agent: ${agentId}`,
    `- Updated: ${fmtTs(state.updatedAtMs)}`,
    `- Inbox open: ${state.inboxItems.filter((item) => item.status !== "trashed").length}`,
    `- Active actions: ${state.actions.filter((item) => item.status === "active").length}`,
    `- Active projects: ${state.projects.filter((item) => item.status === "active").length}`,
    `- Waiting for: ${state.waitingFor.filter((item) => item.status === "active").length}`,
    `- Hard landscape: ${state.calendarItems.filter((item) => item.hardLandscape).length}`,
    `- Last daily review: ${fmtTs(state.reviews.lastDailyAtMs)}`,
    `- Last weekly review: ${fmtTs(state.reviews.lastWeeklyAtMs)}`,
    `- Last horizons review: ${fmtTs(state.reviews.lastHorizonsAtMs)}`,
    `- Calendar sync last success: ${fmtTs(state.sync.google.lastSuccessfulAtMs)}`,
    `- Calendar sync last error: ${state.sync.google.lastError ?? "-"}`,
    `- Scheduler last reconcile: ${fmtTs(state.scheduler.lastReconciledAtMs)}`,
    `- Scheduler last error: ${state.scheduler.lastError ?? "-"}`,
  ];
  return section("Dashboard", lines);
}

export function renderAllViews(params: {
  agentId: string;
  state: GtdState;
}): Record<string, string> {
  return {
    "dashboard.md": renderDashboard(params),
    "inbox.md": renderInbox(params.state),
    "next-actions.md": renderNextActions(params.state),
    "projects.md": renderProjects(params.state),
    "waiting-for.md": renderWaitingFor(params.state),
    "calendar-hard-landscape.md": renderCalendar(params.state),
    "someday-maybe.md": renderSomeday(params.state),
    "horizons.md": renderHorizons(params.state),
    "reviews.md": renderReviews(params.state),
    "commitments.md": renderCommitments(params.state),
  };
}
