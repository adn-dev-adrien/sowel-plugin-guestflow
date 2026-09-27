/**
 * Sowel Plugin — guestFlow gate keys
 *
 * guestFlow keeps a list of keys to create: a stay enters it seven days before
 * its arrival, and leaves it as a revocation when cancelled. This plugin reads
 * that list every hour (and on the Refresh button), makes each stay a shared
 * access on the default profile (spec 181 R9), and reports every result back —
 * the invitation for the guest emails, or the failure and its reason.
 *
 * guestFlow holds no credential on the house; a Sowel that is down is noticed
 * by guestFlow itself, when the list has not been read for three hours.
 */

import { GuestFlowClient, GuestFlowError, checkBaseUrl } from "./client.js";
import { applyKeys } from "./sync.js";
import type {
  EventBus,
  GateResult,
  IntegrationPlugin,
  IntegrationSettingDef,
  IntegrationStatus,
  Logger,
  PluginDeps,
  SettingsManager,
  SharedAccessApi,
} from "./types.js";

const PLUGIN_ID = "guestflow";
const POLL_INTERVAL_MS = 60 * 60_000;
const ALARM_SOURCE = "guestflow";
const ALARM_UNREACHABLE = "guestflow:unreachable";
const ALARM_KEYS = "guestflow:keys";

/** What the owner reads in the Activity feed and the alarm list (French, as the house). */
const REASONS: Record<string, string> = {
  disabled: "les accès partagés sont désactivés dans Sowel",
  unknown_profile: "le profil « Par défaut » n'est pas accordé au plugin guestFlow",
  profile_incomplete: "le profil « Par défaut » n'a aucun portail",
  no_end: "le séjour n'a pas de fin",
  outside_profile: "le séjour sort des dates du profil",
  implausible_stay: "séjour de plus de 31 jours refusé",
  internal_error: "erreur interne",
};

export function reasonOf(result: Extract<GateResult, { ok: false }>): string {
  return REASONS[result.error] ?? result.message;
}

const SETTINGS: IntegrationSettingDef[] = [
  {
    key: "base_url",
    label: "guestFlow address",
    type: "text",
    required: true,
    placeholder: "https://guestflow.example.com",
  },
  { key: "api_key", label: "API key (GATE_API_KEY)", type: "password", required: true },
  {
    key: "signing_secret",
    label: "Signing secret (GATE_SIGNING_SECRET)",
    type: "password",
    required: true,
  },
];

class GuestFlowPlugin implements IntegrationPlugin {
  readonly id = PLUGIN_ID;
  readonly name = "guestFlow";
  readonly description = "Gate keys for guestFlow stays";
  readonly icon = "KeyRound";

  private readonly logger: Logger;
  private readonly eventBus: EventBus;
  private readonly settings: SettingsManager;
  private readonly sharedAccess: SharedAccessApi | undefined;

  private status: IntegrationStatus = "disconnected";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt: string | null = null;
  private running: Promise<void> | null = null;
  /** Alarm id → message raised: each raise reaches the Activity feed and the notifications. */
  private raised = new Map<string, string>();
  private stopped = true;

  constructor(deps: PluginDeps) {
    this.logger = deps.logger;
    this.eventBus = deps.eventBus;
    this.settings = deps.settingsManager;
    this.sharedAccess = deps.sharedAccess;
  }

  private setting(key: string): string {
    return (this.settings.get(`integration.${PLUGIN_ID}.${key}`) ?? "").trim();
  }

  getStatus(): IntegrationStatus {
    return this.status;
  }

  isConfigured(): boolean {
    return Boolean(this.setting("base_url") && this.setting("api_key") && this.setting("signing_secret"));
  }

  getSettingsSchema(): IntegrationSettingDef[] {
    return SETTINGS;
  }

  getPollingInfo(): { lastPollAt: string; intervalMs: number } | null {
    return { lastPollAt: this.lastPollAt ?? "", intervalMs: POLL_INTERVAL_MS };
  }

  async start(options?: { pollOffset?: number }): Promise<void> {
    this.stopped = false;
    if (!this.isConfigured()) {
      this.status = "not_configured";
      return;
    }
    if (!this.sharedAccess) {
      this.status = "error";
      this.logger.error("This Sowel has no shared access (spec 181): guestFlow keys cannot be created");
      return;
    }
    try {
      checkBaseUrl(this.setting("base_url"));
    } catch (err) {
      this.status = "error";
      this.logger.error(
        { baseUrl: this.setting("base_url"), err: err instanceof Error ? err.message : String(err) },
        "guestFlow address refused: an https URL is required",
      );
      return;
    }
    // Connected means « running »: a failed read is an alarm, and the owner
    // keeps the Refresh button to read again.
    this.status = "connected";
    this.eventBus.emit({ type: "system.integration.connected", integrationId: this.id });
    this.schedule(options?.pollOffset ?? 0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => {});
    if (this.status === "connected") {
      this.eventBus.emit({ type: "system.integration.disconnected", integrationId: this.id });
    }
    this.status = "disconnected";
  }

  async executeOrder(): Promise<void> {
    throw new Error("guestFlow has no device to command");
  }

  /** « Relever maintenant »: the integration's Refresh button. */
  async refresh(): Promise<void> {
    await this.poll();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.poll();
      this.schedule(POLL_INTERVAL_MS);
    }, delayMs);
  }

  /** One read at a time: a Refresh during an hourly read waits for it. */
  private poll(): Promise<void> {
    if (!this.running) {
      this.running = this.readOnce().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async readOnce(): Promise<void> {
    if (!this.sharedAccess || !this.isConfigured()) return;
    const client = new GuestFlowClient({
      baseUrl: this.setting("base_url"),
      apiKey: this.setting("api_key"),
      signingSecret: this.setting("signing_secret"),
    });
    let results: GateResult[];
    try {
      const keys = await client.keys();
      results = applyKeys(this.sharedAccess, keys);
      await client.results(results);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ err: message }, "guestFlow read failed");
      this.raise(
        ALARM_UNREACHABLE,
        "error",
        err instanceof GuestFlowError && err.impostor
          ? "Une réponse ne vient pas de guestFlow (signature invalide) : aucune clé créée, rien envoyé"
          : err instanceof GuestFlowError && (err.status === 401 || err.status === 403)
            ? "guestFlow refuse la clé ou la signature : vérifier les secrets du plugin"
            : "guestFlow ne répond pas : les clés du portail ne sont plus relevées",
      );
      return;
    }
    this.lastPollAt = new Date().toISOString();
    this.resolve(ALARM_UNREACHABLE, "guestFlow répond de nouveau");

    const failed = results.filter((r): r is Extract<GateResult, { ok: false }> => !r.ok);
    this.logger.info(
      { keys: results.length, failed: failed.length },
      "guestFlow keys read and results reported",
    );
    if (failed.length > 0) {
      const reasons = [...new Set(failed.map(reasonOf))].join(" ; ");
      this.raise(
        ALARM_KEYS,
        "warning",
        failed.length === 1
          ? `1 clé de séjour n'a pas pu être créée : ${reasons}`
          : `${failed.length} clés de séjour n'ont pas pu être créées : ${reasons}`,
      );
    } else {
      this.resolve(ALARM_KEYS, "Toutes les clés de séjour sont créées");
    }
  }

  private raise(alarmId: string, level: "warning" | "error", message: string): void {
    if (this.raised.get(alarmId) === message) return;
    this.raised.set(alarmId, message);
    this.eventBus.emit({ type: "system.alarm.raised", alarmId, level, source: ALARM_SOURCE, message });
  }

  private resolve(alarmId: string, message: string): void {
    if (!this.raised.delete(alarmId)) return;
    this.eventBus.emit({ type: "system.alarm.resolved", alarmId, source: ALARM_SOURCE, message });
  }
}

export function createPlugin(deps: PluginDeps): IntegrationPlugin {
  return new GuestFlowPlugin(deps);
}
