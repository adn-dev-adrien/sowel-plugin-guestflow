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

export interface DiscoveredDevice {
  friendlyName: string;
  manufacturer?: string;
  model?: string;
  data: { key: string; type: "boolean" | "number" | "enum" | "text"; category: string; unit?: string }[];
  orders: never[];
}

/** The part of `deps.deviceManager` this plugin calls (scoped to its own id). */
export interface DeviceManager {
  upsertFromDiscovery(integrationId: string, source: string, discovered: DiscoveredDevice): void;
  updateDeviceData(
    integrationId: string,
    sourceDeviceId: string,
    payload: Record<string, unknown>,
    sourceTimestamp?: number,
  ): void;
  updateDeviceStatus(integrationId: string, sourceDeviceId: string, status: "online" | "offline"): void;
}

export interface PluginDeps {
  logger: Logger;
  eventBus: EventBus;
  settingsManager: SettingsManager;
  deviceManager: DeviceManager;
  pluginDir: string;
  /** Where the plugin may keep state across updates. Absent on an engine that has none. */
  dataDir?: string;
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

/** The stay behind a key (contract v3). Optional: older guestFlows do not send it. */
export interface Stay {
  propertyId: number;
  propertyName: string;
  /** ISO-8601 with offset. */
  arrival: string;
  departure: string;
}

export interface GateKey {
  reservationId: string;
  action: "create" | "revoke";
  label: string;
  startsAt: string;
  endsAt: string;
  stay?: Stay;
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
