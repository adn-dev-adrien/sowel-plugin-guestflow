// ============================================================
// Local copies of the Sowel types this plugin touches (no import from the
// core: a plugin ships alone).
// ============================================================

export interface Logger {
  info(obj: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  debug(obj: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
}

export interface EventBus {
  emit(event: unknown): void;
}

export interface SettingsManager {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

/** Sowel's access status (spec 181). */
export type AccessState =
  | "live"
  | "outside_hours"
  | "not_yet"
  | "ended"
  | "suspended"
  | "revoked"
  | "no_gate";

/** `deps.sharedAccess`, bound to this plugin (spec 181 R9). */
export interface SharedAccessApi {
  profiles(): { id: string; name: string; isDefault: boolean; complete: boolean }[];
  upsert(
    externalId: string,
    input: { profileId?: string; label: string; from: string | null; until: string },
  ): { id: string; code: string | null; invitationUrl: string | null };
  revoke(externalId: string): void;
  list(): {
    externalId: string;
    state: AccessState;
    code: string | null;
    invitationUrl: string | null;
  }[];
}

export interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: unknown;
  pluginDir: string;
  sharedAccess?: SharedAccessApi;
}

export type IntegrationStatus = "connected" | "disconnected" | "not_configured" | "error";

export interface IntegrationSettingDef {
  key: string;
  label: string;
  type: "text" | "password" | "number" | "boolean";
  required: boolean;
  placeholder?: string;
  defaultValue?: string;
}

export interface IntegrationPlugin {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly icon: string;
  getStatus(): IntegrationStatus;
  isConfigured(): boolean;
  getSettingsSchema(): IntegrationSettingDef[];
  start(options?: { pollOffset?: number }): Promise<void>;
  stop(): Promise<void>;
  executeOrder(device: unknown, orderKey: unknown, value: unknown): Promise<void>;
  refresh?(): Promise<void>;
  getPollingInfo?(): { lastPollAt: string; intervalMs: number } | null;
}

// ── The wire contract with guestFlow ─────────────────────────

export interface GateKey {
  reservationId: string;
  action: "create" | "revoke";
  label: string;
  startsAt: string;
  endsAt: string;
}

export type GateResult =
  | {
      reservationId: string;
      action: "create" | "revoke";
      ok: true;
      state: AccessState;
      code?: string | null;
      url?: string | null;
    }
  | {
      reservationId: string;
      action: "create" | "revoke";
      ok: false;
      error: string;
      message: string;
    };
