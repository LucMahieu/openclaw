export type CodexHandoffPhase =
  | "queued"
  | "running"
  | "waiting-input"
  | "done"
  | "failed"
  | "cancelled"
  | "stale";

export type CodexHandoffTask = {
  taskId: string;
  runId: string;
  childSessionKey: string;
  requesterSessionKey: string;
  agentId?: string;
  summary?: string;
  phase: CodexHandoffPhase;
  terminal: boolean;
  createdAt: number;
  updatedAt: number;
  lastHeartbeatAt?: number;
  lastEventAt?: number;
  attempt: number;
  nextCheckAt?: number;
  monitorCronJobId?: string;
  monitorEnabled: boolean;
};

export type CodexHandoffConfig = {
  monitorEnabled: boolean;
  monitorIntervalSeconds: number;
  monitorMaxAttempts: number;
  staleTimeoutSeconds: number;
  requirePushAck: boolean;
  autoRescheduleOnInFlight: boolean;
  retryBackoffSeconds: number[];
};

export type ParsedCodexStatusEvent = {
  raw: string;
  phase: CodexHandoffPhase;
  taskId?: string;
  sessionId?: string;
  summary?: string;
};

export type ParsedCodexWatchdogEvent = {
  raw: string;
  taskId?: string;
};
