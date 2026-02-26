import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "openclaw/plugin-sdk";
import { generateUlid } from "../canonical-json.js";
import type { CalendarItem, GtdState, GoogleSyncMapping } from "../schema.js";
import type { GtdStoreContext } from "../store.js";
import { resolveAgentDirFromStateDir } from "../store.js";

type AuthProfileCredential =
  | {
      type: "oauth";
      provider: string;
      access: string;
      refresh?: string;
      expires: number;
      clientId?: string;
      clientSecret?: string;
      [key: string]: unknown;
    }
  | {
      type: "token";
      provider: string;
      token: string;
      expires?: number;
      [key: string]: unknown;
    }
  | {
      type: "api_key";
      provider: string;
      key?: string;
      [key: string]: unknown;
    };

type AuthProfileStore = {
  version?: number;
  profiles?: Record<string, AuthProfileCredential>;
};

const LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 25,
    maxTimeout: 2_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

type GoogleEvent = {
  id?: string;
  etag?: string;
  status?: string;
  summary?: string;
  updated?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  extendedProperties?: {
    private?: Record<string, string>;
  };
};

export type GoogleCalendarSyncSummary = {
  ok: boolean;
  pulled: number;
  pushed: number;
  deleted: number;
  message: string;
};

function parseJsonSafely<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function authStorePath(ctx: GtdStoreContext, agentId: string): string {
  return path.join(resolveAgentDirFromStateDir(ctx.stateDir, agentId), "auth-profiles.json");
}

function formatDateForAllDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function toCalendarPayload(item: CalendarItem): Record<string, unknown> {
  const base: Record<string, unknown> = {
    summary: item.title,
    extendedProperties: {
      private: {
        gtdLocalId: item.id,
      },
    },
  };

  if (item.allDay) {
    base.start = { date: formatDateForAllDay(item.startMs) };
    base.end = { date: formatDateForAllDay(item.endMs) };
  } else {
    base.start = { dateTime: new Date(item.startMs).toISOString() };
    base.end = { dateTime: new Date(item.endMs).toISOString() };
  }

  return base;
}

function parseCalendarTimes(event: GoogleEvent): {
  startMs: number;
  endMs: number;
  allDay: boolean;
} {
  const startRaw = event.start?.dateTime ?? event.start?.date;
  const endRaw = event.end?.dateTime ?? event.end?.date;
  const startMs = Date.parse(startRaw ?? "");
  const endMs = Date.parse(endRaw ?? "");
  const allDay = Boolean(event.start?.date && !event.start?.dateTime);

  return {
    startMs: Number.isFinite(startMs) ? startMs : Date.now(),
    endMs: Number.isFinite(endMs) ? endMs : Date.now() + 60 * 60 * 1000,
    allDay,
  };
}

function isUlidLike(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

function profilePriority(profileId: string, configuredProfileIds: string[]): number {
  const idx = configuredProfileIds.indexOf(profileId);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

function resolveConfiguredGoogleProfileIds(cfg: GtdStoreContext["config"]): string[] {
  const entries = Object.entries(cfg.auth?.profiles ?? {});
  const filtered = entries
    .filter(([, value]) => value?.provider === "google-calendar")
    .map(([id]) => id.trim())
    .filter(Boolean);
  return filtered;
}

async function readAuthStore(ctx: GtdStoreContext, agentId: string): Promise<AuthProfileStore> {
  const filePath = authStorePath(ctx, agentId);
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return parseJsonSafely<AuthProfileStore>(raw) ?? {};
  } catch {
    return {};
  }
}

async function writeAuthStore(
  ctx: GtdStoreContext,
  agentId: string,
  store: AuthProfileStore,
): Promise<void> {
  const filePath = authStorePath(ctx, agentId);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await withFileLock(filePath, LOCK_OPTIONS, async () => {
    const tmp = `${filePath}.${Date.now().toString(36)}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, filePath);
  });
}

async function refreshGoogleAccessToken(params: {
  credential: Extract<AuthProfileCredential, { type: "oauth" }>;
}): Promise<Extract<AuthProfileCredential, { type: "oauth" }> | null> {
  const refreshToken = params.credential.refresh?.trim();
  if (!refreshToken) {
    return null;
  }

  const clientId =
    (typeof params.credential.clientId === "string" && params.credential.clientId.trim()) ||
    process.env.OPENCLAW_GTD_GOOGLE_CLIENT_ID?.trim() ||
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_ID?.trim() ||
    "";
  const clientSecret =
    (typeof params.credential.clientSecret === "string" && params.credential.clientSecret.trim()) ||
    process.env.OPENCLAW_GTD_GOOGLE_CLIENT_SECRET?.trim() ||
    process.env.GOOGLE_CALENDAR_OAUTH_CLIENT_SECRET?.trim() ||
    "";

  if (!clientId || !clientSecret) {
    return null;
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    return null;
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token) {
    return null;
  }

  const expires = Date.now() + Math.max(60, payload.expires_in ?? 3600) * 1000 - 60_000;
  return {
    ...params.credential,
    access: payload.access_token,
    expires,
    clientId,
    clientSecret,
  };
}

async function resolveGoogleAccessToken(
  ctx: GtdStoreContext,
  agentId: string,
): Promise<{ accessToken: string; profileId: string } | null> {
  const store = await readAuthStore(ctx, agentId);
  const profiles = store.profiles ?? {};
  const configuredProfileIds = resolveConfiguredGoogleProfileIds(ctx.config);

  const candidates = Object.entries(profiles)
    .filter(([, credential]) => credential?.provider === "google-calendar")
    .toSorted(
      (a, b) =>
        profilePriority(a[0], configuredProfileIds) - profilePriority(b[0], configuredProfileIds),
    );

  for (const [profileId, credential] of candidates) {
    if (credential.type === "token") {
      if (credential.expires && credential.expires <= Date.now()) {
        continue;
      }
      const token = credential.token?.trim();
      if (token) {
        return { accessToken: token, profileId };
      }
      continue;
    }

    if (credential.type !== "oauth") {
      continue;
    }

    if (credential.expires > Date.now() && credential.access.trim()) {
      return { accessToken: credential.access, profileId };
    }

    const refreshed = await refreshGoogleAccessToken({ credential });
    if (!refreshed) {
      continue;
    }

    const updatedStore: AuthProfileStore = {
      version: store.version,
      profiles: {
        ...profiles,
        [profileId]: refreshed,
      },
    };
    await writeAuthStore(ctx, agentId, updatedStore);
    return { accessToken: refreshed.access, profileId };
  }

  return null;
}

async function googleRequest<T>(params: {
  method?: "GET" | "POST" | "PATCH";
  token: string;
  url: string;
  body?: unknown;
}): Promise<{ ok: true; value: T } | { ok: false; status: number; text: string }> {
  const response = await fetch(params.url, {
    method: params.method ?? "GET",
    headers: {
      Authorization: `Bearer ${params.token}`,
      "Content-Type": "application/json",
    },
    body: params.body == null ? undefined : JSON.stringify(params.body),
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      text: await response.text(),
    };
  }

  if (response.status === 204) {
    return { ok: true, value: {} as T };
  }

  return {
    ok: true,
    value: (await response.json()) as T,
  };
}

function upsertMapping(mappings: GoogleSyncMapping[], next: GoogleSyncMapping): void {
  const index = mappings.findIndex((entry) => entry.localId === next.localId);
  if (index >= 0) {
    const existing = mappings[index];
    mappings[index] = {
      ...existing,
      ...next,
      createdAtMs: existing.createdAtMs,
    };
    return;
  }
  mappings.push({
    ...next,
    createdAtMs: next.createdAtMs || Date.now(),
  });
}

function removeMappingByRemoteId(mappings: GoogleSyncMapping[], remoteId: string): void {
  const index = mappings.findIndex((entry) => entry.remoteId === remoteId);
  if (index >= 0) {
    mappings.splice(index, 1);
  }
}

export async function syncGoogleCalendar(params: {
  ctx: GtdStoreContext;
  agentId: string;
  state: GtdState;
}): Promise<GoogleCalendarSyncSummary> {
  const { ctx, agentId, state } = params;
  const auth = await resolveGoogleAccessToken(ctx, agentId);
  if (!auth) {
    state.sync.google.lastError = "Google Calendar auth missing for provider google-calendar";
    return {
      ok: false,
      pulled: 0,
      pushed: 0,
      deleted: 0,
      message: state.sync.google.lastError,
    };
  }

  const mappings = state.sync.google.mappings;
  let pulled = 0;
  let pushed = 0;
  let deleted = 0;

  let nextPageToken: string | undefined;
  let latestSyncToken: string | undefined;

  do {
    const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("maxResults", "2500");
    if (state.sync.google.syncToken) {
      url.searchParams.set("syncToken", state.sync.google.syncToken);
    } else {
      url.searchParams.set(
        "timeMin",
        new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      );
    }
    if (nextPageToken) {
      url.searchParams.set("pageToken", nextPageToken);
    }

    const response = await googleRequest<{
      items?: GoogleEvent[];
      nextPageToken?: string;
      nextSyncToken?: string;
    }>({
      token: auth.accessToken,
      url: url.toString(),
    });

    if (!response.ok) {
      state.sync.google.lastError = `pull failed (${response.status}): ${response.text.slice(0, 200)}`;
      return {
        ok: false,
        pulled,
        pushed,
        deleted,
        message: state.sync.google.lastError,
      };
    }

    const events = response.value.items ?? [];
    for (const event of events) {
      if (!event.id) {
        continue;
      }

      if (event.status === "cancelled") {
        removeMappingByRemoteId(mappings, event.id);
        const localIndex = state.calendarItems.findIndex((item) => item.externalId === event.id);
        if (localIndex >= 0 && state.calendarItems[localIndex]?.source === "google") {
          state.calendarItems.splice(localIndex, 1);
          deleted += 1;
        }
        continue;
      }

      const localIdFromExt = event.extendedProperties?.private?.gtdLocalId?.trim();
      const times = parseCalendarTimes(event);
      const now = Date.now();

      if (localIdFromExt) {
        const existingMapped = mappings.find((entry) => entry.remoteId === event.id);
        const normalizedLocalId = isUlidLike(localIdFromExt)
          ? localIdFromExt
          : existingMapped?.localId || generateUlid();
        const existingLocal = state.calendarItems.find((item) => item.id === normalizedLocalId);
        if (!existingLocal) {
          state.calendarItems.push({
            id: normalizedLocalId,
            title: event.summary?.trim() || "Untitled",
            startMs: times.startMs,
            endMs: times.endMs,
            allDay: times.allDay,
            hardLandscape: true,
            source: "gtd",
            externalId: event.id,
            etag: event.etag,
            createdAtMs: now,
            updatedAtMs: now,
          });
          pulled += 1;
        }

        upsertMapping(mappings, {
          localId: normalizedLocalId,
          remoteId: event.id,
          createdAtMs:
            mappings.find((entry) => entry.localId === normalizedLocalId)?.createdAtMs ||
            existingMapped?.createdAtMs ||
            Date.now(),
          etag: event.etag,
          updatedAtMs: Date.parse(event.updated ?? "") || undefined,
        });
        continue;
      }

      const localId = `gcal_${event.id}`;
      const mappedExisting = mappings.find((entry) => entry.remoteId === event.id);
      const resolvedLocalId = mappedExisting?.localId || localId;
      const existing = state.calendarItems.find((item) => item.id === resolvedLocalId);
      if (existing) {
        existing.title = event.summary?.trim() || existing.title;
        existing.startMs = times.startMs;
        existing.endMs = times.endMs;
        existing.allDay = times.allDay;
        existing.hardLandscape = true;
        existing.source = "google";
        existing.externalId = event.id;
        existing.etag = event.etag;
        existing.updatedAtMs = now;
      } else {
        state.calendarItems.push({
          id: mappedExisting?.localId || generateUlid(),
          title: event.summary?.trim() || "Untitled",
          startMs: times.startMs,
          endMs: times.endMs,
          allDay: times.allDay,
          hardLandscape: true,
          source: "google",
          externalId: event.id,
          etag: event.etag,
          createdAtMs: now,
          updatedAtMs: now,
        });
        pulled += 1;
      }

      upsertMapping(mappings, {
        localId:
          state.calendarItems.find((item) => item.externalId === event.id)?.id ??
          mappedExisting?.localId ??
          generateUlid(),
        remoteId: event.id,
        createdAtMs: mappedExisting?.createdAtMs || Date.now(),
        etag: event.etag,
        updatedAtMs: Date.parse(event.updated ?? "") || undefined,
      });
    }

    nextPageToken = response.value.nextPageToken;
    latestSyncToken = response.value.nextSyncToken ?? latestSyncToken;
  } while (nextPageToken);

  const localHardLandscape = state.calendarItems.filter(
    (item) => item.hardLandscape && item.source !== "google",
  );

  for (const item of localHardLandscape) {
    const mapped = mappings.find((entry) => entry.localId === item.id);
    const payload = toCalendarPayload(item);

    if (mapped) {
      const patchUrl = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(
          mapped.remoteId,
        )}`,
      );
      patchUrl.searchParams.set("sendUpdates", "none");

      const patchRes = await googleRequest<GoogleEvent>({
        method: "PATCH",
        token: auth.accessToken,
        url: patchUrl.toString(),
        body: payload,
      });

      if (!patchRes.ok) {
        state.sync.google.lastError = `push patch failed (${patchRes.status}): ${patchRes.text.slice(0, 200)}`;
        continue;
      }

      item.externalId = patchRes.value.id;
      item.etag = patchRes.value.etag;
      item.updatedAtMs = Date.now();
      upsertMapping(mappings, {
        localId: item.id,
        remoteId: patchRes.value.id ?? mapped.remoteId,
        createdAtMs: mapped.createdAtMs,
        etag: patchRes.value.etag,
        updatedAtMs: Date.parse(patchRes.value.updated ?? "") || undefined,
      });
      pushed += 1;
      continue;
    }

    const postUrl = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    postUrl.searchParams.set("sendUpdates", "none");
    const createRes = await googleRequest<GoogleEvent>({
      method: "POST",
      token: auth.accessToken,
      url: postUrl.toString(),
      body: payload,
    });

    if (!createRes.ok) {
      state.sync.google.lastError = `push create failed (${createRes.status}): ${createRes.text.slice(0, 200)}`;
      continue;
    }

    if (createRes.value.id) {
      item.externalId = createRes.value.id;
      item.etag = createRes.value.etag;
      item.updatedAtMs = Date.now();
      upsertMapping(mappings, {
        localId: item.id,
        remoteId: createRes.value.id,
        createdAtMs: Date.now(),
        etag: createRes.value.etag,
        updatedAtMs: Date.parse(createRes.value.updated ?? "") || undefined,
      });
      pushed += 1;
    }
  }

  state.sync.google.syncToken = latestSyncToken ?? state.sync.google.syncToken;
  state.sync.google.lastPullAtMs = Date.now();
  state.sync.google.lastPushAtMs = Date.now();
  state.sync.google.lastSuccessfulAtMs = Date.now();
  state.sync.google.lastError = undefined;

  return {
    ok: true,
    pulled,
    pushed,
    deleted,
    message: `sync ok (profile=${auth.profileId}, pulled=${pulled}, pushed=${pushed}, deleted=${deleted})`,
  };
}
