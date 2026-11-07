import {
  ConfirmModal,
  DialogBody,
  DialogBodyText,
  DialogButton,
  DialogButtonPrimary,
  DialogControlsSection,
  DialogHeader,
  Field,
  Focusable,
  Navigation,
  TextField,
  ToggleField,
  SidebarNavigation,
  showModal,
  staticClasses,
} from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, routerHook, toaster } from "@decky/api";
import { ReactNode, useEffect, useState } from "react";
import { FaCog, FaPlug, FaUnlink } from "react-icons/fa";
import { AboutIcon, PairedDevicesIcon, RemoteInputIcon, ServerIcon } from "./icons";
import { Mark } from "./Mark";
import { SteamingMark } from "./SteamingMark";
import { installTweakApi, restoreAll, setOff, SettingsSection, settingsPages, showTopBarIcon, theme, TOP_BAR_ICON, useTransparentHeader } from "./steam";

type Status = {
  enabled: boolean;
  running: boolean;
  bind: string;
  port: number;
  ip: string;
  pair_requests: number;
  stream: { running: boolean; fps: number; subscribers: number; available: boolean; error: string | null } | null;
  input: InputSettings | null;
  error: string | null;
  connected?: boolean;
  clients?: ConnectedClient[];
  version?: string;
  ui_tweaks_off?: string[];
};

type ConnectedClient = {
  fingerprint: string;
  name: string;
  kind: string;
  remote: string | null;
  connected_since: number | null;
  streaming?: boolean;
};

type PairRequest = {
  id: string;
  code: string;
  client_name: string;
  client_kind: string;
  remote: string;
  status: "pending" | "approved" | "denied";
  age_s: number;
};

type PairedClient = {
  fingerprint: string;
  name: string;
  kind: string;
  added_at: number;
  last_seen: number | null;
  connected?: boolean;
  connected_since?: number | null;
  remote?: string | null;
};

type InputSettings = { enabled: boolean; backend: "ei" | "uinput" | null; available: boolean; reason: string | null };

const PLUGIN_NAME = "Decky Toolkit";
const SETTINGS_ROUTE = "/decky-toolkit/settings";
const STATUS_POLL_MS = 5000;
const PROJECT_URL = "https://github.com/jackhric/decky-toolkit";
const INPUT_BACKENDS: Record<string, string> = { ei: "gamescope (libei)", uinput: "Virtual devices (uinput)" };
const KIND_LABELS: Record<string, string> = { vscode: "VS Code", mcp: "MCP client", other: "Other" };

const getStatus = callable<[], Status>("get_status");
const setEnabled = callable<[enabled: boolean], Status>("set_enabled");
const setPort = callable<[port: number], Status>("set_port");
const restartServer = callable<[], Status>("restart_server");
const listPairRequests = callable<[], PairRequest[]>("list_pair_requests");
const approvePairRequest = callable<[id: string], PairRequest[]>("approve_pair_request");
const denyPairRequest = callable<[id: string], PairRequest[]>("deny_pair_request");
const listPairedClients = callable<[], PairedClient[]>("list_paired_clients");
const forgetPairedClient = callable<[fingerprint: string], PairedClient[]>("forget_paired_client");
const setInputEnabled = callable<[enabled: boolean], InputSettings>("set_input_enabled");
const setUiTweak = callable<[name: string, enabled: boolean], Status>("set_ui_tweak");

const toast = (body: string) => toaster.toast({ title: "Decky Toolkit", body });
const toastError = (e: unknown) => toaster.toast({ title: "Decky Toolkit error", body: String(e) });

function lastSeen(at: number | null): string {
  if (at === null) return "never seen";
  const minutes = Math.floor((Date.now() / 1000 - at) / 60);
  if (minutes < 2) return "seen just now";
  if (minutes < 60) return `seen ${minutes} min ago`;
  if (minutes < 48 * 60) return `seen ${Math.floor(minutes / 60)} h ago`;
  return `seen ${Math.floor(minutes / 1440)} days ago`;
}

function connectedFor(since: number | null, now: number): string {
  const minutes = since === null ? 0 : Math.floor((now / 1000 - since) / 60);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const m = minutes % 60;
  return `${Math.floor(minutes / 60)} h${m ? ` ${m} min` : ""}`;
}

function useNow(everyMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

function serverState(s: Status): string {
  if (s.error) return s.error;
  if (!s.enabled) return "Disabled";
  return s.running ? "Running" : "Stopped";
}

function useToolkit() {
  const [status, setStatus] = useState<Status | null>(null);
  const [requests, setRequests] = useState<PairRequest[]>([]);
  const [clients, setClients] = useState<PairedClient[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setStatus(await getStatus());
    setClients(await listPairedClients());
  };
  const refreshRequests = async () => setRequests(await listPairRequests());
  const pending = requests.filter((r) => r.status === "pending").sort((a, b) => b.age_s - a.age_s);

  useEffect(() => {
    const onInput = addEventListener<[enabled: boolean]>("decky_toolkit_input_state", () => refresh());
    const onRequest = addEventListener<[info: unknown]>("decky_toolkit_pair_request", () => refreshRequests());
    const onRequests = addEventListener<[list: PairRequest[]]>("decky_toolkit_pair_requests", setRequests);
    const onClients = addEventListener<[list: PairedClient[]]>("decky_toolkit_paired_clients", setClients);
    const onTweaks = addEventListener<[off: string[]]>("decky_toolkit_ui_tweaks", (off) => setStatus((s) => (s ? { ...s, ui_tweaks_off: off } : s)));
    refresh();
    const id = setInterval(refresh, STATUS_POLL_MS);
    return () => {
      clearInterval(id);
      removeEventListener("decky_toolkit_input_state", onInput);
      removeEventListener("decky_toolkit_pair_request", onRequest);
      removeEventListener("decky_toolkit_pair_requests", onRequests);
      removeEventListener("decky_toolkit_paired_clients", onClients);
      removeEventListener("decky_toolkit_ui_tweaks", onTweaks);
    };
  }, []);

  useEffect(() => {
    refreshRequests();
    const id = setInterval(refreshRequests, pending.length ? 2000 : 10000);
    return () => clearInterval(id);
  }, [pending.length > 0]);

  const guarded = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return {
    status,
    pending,
    clients,
    busy,
    decide: (r: PairRequest, allow: boolean) =>
      guarded(async () => {
        try {
          setRequests(await (allow ? approvePairRequest(r.id) : denyPairRequest(r.id)));
          toast(`${allow ? "Approved" : "Denied"} ${r.client_name}`);
        } catch (e) {
          refreshRequests();
          throw e;
        }
      }),
    run: (fn: () => Promise<Status>, okMsg?: string) =>
      guarded(async () => {
        setStatus(await fn());
        if (okMsg) toast(okMsg);
      }),
    setInput: (enabled: boolean) =>
      guarded(async () => {
        const input = await setInputEnabled(enabled);
        setStatus((s) => (s ? { ...s, input } : s));
      }),
    forget: (c: PairedClient) =>
      showModal(
        <ConfirmModal
          strTitle={`Forget ${c.name}?`}
          strDescription="It has to pair again to connect to this device."
          strOKButtonText="Forget"
          onOK={() =>
            guarded(async () => {
              setClients(await forgetPairedClient(c.fingerprint));
              toast(`Forgot ${c.name}`);
            })
          }
        />,
      ),
    disconnect: ({ name, fingerprint }: ConnectedClient) =>
      showModal(
        <ConfirmModal
          strTitle={`Disconnect ${name}?`}
          strDescription="The editor is disconnected and has to pair again to connect."
          strOKButtonText="Disconnect"
          onOK={() =>
            guarded(async () => {
              setClients(await forgetPairedClient(fingerprint));
              setStatus(await getStatus());
              toast(`Disconnected ${name}`);
            })
          }
        />,
      ),
  };
}

/** Whether a computer is connected, for the top bar icon; polls like the panel does. */
function useConnected(): boolean {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let live = true;
    const poll = () => getStatus().then((s) => live && setConnected(!!s.clients?.length), () => {});
    poll();
    const id = setInterval(poll, STATUS_POLL_MS);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);
  return connected;
}

const showPairingHelp = () =>
  showModal(
    <ConfirmModal
      bAlertDialog
      strTitle="How pairing works"
      strOKButtonText="OK"
      strDescription={
        <ol style={{ margin: 0, paddingLeft: "1.4em", lineHeight: 1.6 }}>
          <li>Install the Decky Toolkit extension in VS Code on your computer.</li>
          <li>In the extension, add the address shown in the Decky Toolkit panel.</li>
          <li>A request appears here. Approve it if its code matches the one on your computer.</li>
        </ol>
      }
    />,
  );

const STYLE = `
.dtk-card { border-radius: ${theme.radius}; background: ${theme.surface}; transition: background 0.15s; }
.dtk-card.dtk-focus { background: ${theme.surfaceFocus}; box-shadow: inset 0 0 0 2px ${theme.focusRing}; }
.dtk-link.dtk-focus { text-decoration: underline; color: ${theme.textTitle} !important; }
.dtk-row { display: flex; justify-content: space-between; gap: 10px; font-size: ${theme.textSize(3)}; color: ${theme.textMuted}; }
.dtk-row > span:last-child:not(:first-child) { color: ${theme.textSubtitle}; text-align: right; font-variant-numeric: tabular-nums; }
.dtk-card-footer { margin: 10px -14px 0 !important; width: calc(100% + 28px) !important; border-radius: 0 !important; background: ${theme.surfaceRaised} !important; color: ${theme.textSubtitle} !important; }
.dtk-card-footer.gpfocus, .dtk-card-footer:hover { background: ${theme.focusBackground} !important; color: ${theme.focusText} !important; }
.dtk-primary { background: ${theme.accent} !important; color: ${theme.textTitle} !important; }
.dtk-primary.gpfocus { background: ${theme.accentBright} !important; box-shadow: 0 0 0 2px ${theme.focusBackground}; }
.dtk-mark { color: ${theme.textMuted}; transition: color 0.4s; }
.dtk-mark.connected { color: ${theme.positive}; }
.dtk-mark.pending { animation: dtk-breathe 2s ease-in-out infinite; }
@keyframes dtk-breathe { 0%, 100% { color: ${theme.accentDim}; opacity: 0.75; } 50% { color: ${theme.accent}; opacity: 1; } }
`;

type MarkState = "idle" | "pending" | "connected";

function Centered({ children, mark = "idle" }: { children: ReactNode; mark?: MarkState }) {
  return (
    <Focusable
      flow-children="column"
      // Quick Access gives plugin content no height of its own; 72px is the panel header above it.
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: "16px",
        padding: "16px",
        minHeight: "calc(100vh - 72px)",
        boxSizing: "border-box",
      }}
    >
      <style>{STYLE}</style>
      <SteamingMark size={96} steaming={mark === "connected"} className={`dtk-mark ${mark}`} style={{ marginBottom: "8px" }} />
      {children}
      <Focusable
        className="dtk-link"
        focusClassName="dtk-focus"
        noFocusRing
        onActivate={showPairingHelp}
        onClick={showPairingHelp}
        style={{ color: theme.accent, fontSize: theme.textSize(4), padding: "4px 8px", cursor: "pointer" }}
      >
        How pairing works
      </Focusable>
    </Focusable>
  );
}

const hint = { color: theme.textMuted, fontSize: theme.textSize(4), lineHeight: 1.45, margin: 0, maxWidth: "260px" } as const;

function ConnectionCard({ client, status, busy, onDisconnect }: { client: ConnectedClient; status: Status; busy: boolean; onDisconnect: () => void }) {
  const now = useNow(15000);
  const stream = status.stream?.running && client.streaming ? status.stream : null;
  return (
    <Focusable
      className="dtk-card"
      flow-children="column"
      style={{ width: "100%", padding: "14px 14px 0", boxSizing: "border-box", overflow: "hidden", display: "flex", flexDirection: "column", gap: "4px", textAlign: "left" }}
    >
      <div style={{ fontSize: theme.textSize(6), fontWeight: 600, color: theme.textTitle, overflowWrap: "anywhere" }}>{client.name}</div>
      <div className="dtk-row">
        <span>{KIND_LABELS[client.kind] ?? client.kind}</span>
        {client.remote && <span>{client.remote}</span>}
      </div>
      <div className="dtk-row">
        <span>Connected</span>
        <span>{connectedFor(client.connected_since, now)}</span>
      </div>
      {stream && (
        <div className="dtk-row">
          <span>Screen</span>
          <span>{stream.fps > 0 ? `${Math.round(stream.fps)} fps` : "streaming"}</span>
        </div>
      )}
      <DialogButton
        className="dtk-card-footer"
        aria-label={`Disconnect ${client.name}`}
        disabled={busy}
        onClick={onDisconnect}
        style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}
      >
        <FaUnlink style={{ display: "block" }} />
        Disconnect
      </DialogButton>
    </Focusable>
  );
}

function Panel() {
  const { status, pending, busy, decide, disconnect } = useToolkit();
  const current = pending[0];
  const up = !!status && status.enabled && status.running && !status.error;

  if (current) {
    return (
      <Centered mark="pending">
        <DialogButtonPrimary className="dtk-primary" style={{ width: "100%" }} disabled={busy} onClick={() => decide(current, true)}>
          Approve {current.client_name}
        </DialogButtonPrimary>
        <div style={{ color: theme.textMuted, fontSize: theme.textSize(3), marginTop: "-6px" }}>
          Code <span style={{ color: theme.textTitle, fontSize: theme.textSize(5), fontWeight: 600, letterSpacing: "0.12em" }}>{current.code}</span>
          {" · "}
          {current.remote}
        </div>
        <DialogButton style={{ width: "100%" }} disabled={busy} onClick={() => decide(current, false)}>
          Deny
        </DialogButton>
        <p style={hint}>
          Approve only if the code matches the one shown on your computer.
          {pending.length > 1 && ` Request 1 of ${pending.length}.`}
        </p>
      </Centered>
    );
  }

  if (!status) {
    return (
      <Centered>
        <p style={hint}>Loading…</p>
      </Centered>
    );
  }

  if (up && status.clients?.length) {
    return (
      <Centered mark="connected">
        {status.clients.map((c) => (
          <ConnectionCard key={c.fingerprint} client={c} status={status} busy={busy} onDisconnect={() => disconnect(c)} />
        ))}
      </Centered>
    );
  }

  return (
    <Centered mark="idle">
      <Focusable
        className="dtk-card"
        focusClassName="dtk-focus"
        noFocusRing
        onActivate={() => {}}
        style={{ width: "100%", padding: "14px 8px", boxSizing: "border-box" }}
      >
        <div style={{ fontSize: theme.textSize(8), fontWeight: 600, color: up ? theme.textTitle : theme.textMuted, letterSpacing: "0.02em" }}>{status.ip}</div>
        <div style={{ fontSize: theme.textSize(3), color: theme.textMuted, marginTop: "2px" }}>port {status.port}</div>
      </Focusable>
      <p style={hint}>
        {up
          ? "Add this address in the Decky Toolkit extension."
          : status.error
            ? `The server is not running: ${status.error}`
            : !status.enabled
              ? "The server is turned off. Turn it on in settings."
              : "The server is stopped. Restart it in settings."}
      </p>
    </Centered>
  );
}

function SettingsPage() {
  useTransparentHeader();
  const { status, clients, busy, run, setInput, forget } = useToolkit();
  const [port, setPortDraft] = useState("");
  useEffect(() => {
    if (status) setPortDraft(String(status.port));
  }, [status?.port]);

  const applyPort = () => {
    const n = Number(port);
    if (!status || n === status.port) return;
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      toastError("Port must be 1024-65535");
      setPortDraft(String(status.port));
      return;
    }
    run(() => setPort(n), `Server moved to port ${n}`);
  };

  const server = (
    <DialogBody>
      <DialogControlsSection>
        <ToggleField
          label="Enable server"
          description="Lets paired computers connect to this device."
          checked={!!status?.enabled}
          disabled={busy || !status}
          onChange={(v) => run(() => setEnabled(v), v ? "Server enabled" : "Server disabled")}
        />
        <Field label="Status" focusable>
          {status ? serverState(status) : "Loading…"}
        </Field>
      </DialogControlsSection>
      <SettingsSection title="Steam">
        <ToggleField
          label="Show in top bar"
          description="The Decky Toolkit mark at the left of the top bar, green while a computer is connected. Selecting it opens this panel."
          checked={!!status && !status.ui_tweaks_off?.includes(TOP_BAR_ICON)}
          disabled={busy || !status}
          onChange={(v) => run(() => setUiTweak(TOP_BAR_ICON, v))}
        />
      </SettingsSection>
      <SettingsSection title="Network">
        <Field label="Address" focusable>
          {status ? `${status.ip}:${status.port}` : "…"}
        </Field>
        <Field label="Port" description="1024-65535. Changing it restarts the server." childrenContainerWidth="fixed">
          <TextField
            mustBeNumeric
            rangeMin={1024}
            rangeMax={65535}
            value={port}
            disabled={busy || !status}
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={applyPort}
            onKeyDown={(e) => e.key === "Enter" && applyPort()}
          />
        </Field>
        <Field label="Restart server" description="Stops and starts the server. Connected computers reconnect." childrenContainerWidth="fixed">
          <DialogButton disabled={busy} onClick={() => run(restartServer, "Server restarted")}>
            Restart
          </DialogButton>
        </Field>
      </SettingsSection>
    </DialogBody>
  );

  const input = (
    <DialogBody>
      <DialogControlsSection>
        <ToggleField
          label="Allow remote input"
          description="Lets paired computers send keyboard, mouse and controller input."
          checked={!!status?.input?.enabled}
          disabled={busy || !status?.input?.available}
          onChange={setInput}
        />
        <Field label="Input method" focusable>
          {!status?.input
            ? "…"
            : status.input.available
              ? INPUT_BACKENDS[status.input.backend ?? ""] ?? status.input.backend
              : status.input.reason ?? "Unavailable"}
        </Field>
      </DialogControlsSection>
    </DialogBody>
  );

  const devices = (
    <DialogBody>
      <DialogControlsSection>
        {clients.length === 0 && <Field label="No paired computers" description="Pair a computer from the Decky Toolkit panel in Quick Access." focusable />}
        {clients.map((c) => (
          <Field
            key={c.fingerprint}
            label={c.name}
            description={`${KIND_LABELS[c.kind] ?? c.kind} · ${c.connected ? "Connected" : lastSeen(c.last_seen)}`}
            childrenContainerWidth="fixed"
          >
            <DialogButton disabled={busy} onClick={() => forget(c)}>
              Forget
            </DialogButton>
          </Field>
        ))}
      </DialogControlsSection>
    </DialogBody>
  );

  const about = (
    <DialogBody>
      {/* DialogBody is a full-height flex column: auto margins centre this when there is room and collapse when not. */}
      <div style={{ margin: "auto 0" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", padding: "24px 0 8px" }}>
          <Mark size={128} style={{ color: theme.textMuted }} />
          <DialogHeader style={{ marginTop: "16px" }}>Decky Toolkit</DialogHeader>
          <DialogBodyText>{status?.version ? `Version ${status.version}` : "…"}</DialogBodyText>
          <DialogBodyText>Lets coding agents and your editor inspect and control this SteamOS device.</DialogBodyText>
        </div>
        <SettingsSection title="Credits">
          <Field label="License" focusable>
            MIT
          </Field>
          <Field label="Project page" description={PROJECT_URL} childrenContainerWidth="fixed">
            <DialogButton onClick={() => Navigation.NavigateToExternalWeb(PROJECT_URL)}>Open</DialogButton>
          </Field>
        </SettingsSection>
      </div>
    </DialogBody>
  );

  return (
    <SidebarNavigation
      pages={settingsPages(
        [
          { title: "Server", icon: <ServerIcon />, content: server, identifier: "server" },
          { title: "Remote Input", icon: <RemoteInputIcon />, content: input, identifier: "input" },
          { title: "Paired Devices", icon: <PairedDevicesIcon />, content: devices, identifier: "devices" },
        ],
        [{ title: "About", icon: <AboutIcon />, content: about, identifier: "about", hideTitle: true }],
      )}
    />
  );
}

export default definePlugin(() => {
  installTweakApi();
  let unloaded = false;
  const tweaksOff = addEventListener<[off: string[]]>("decky_toolkit_ui_tweaks", setOff);
  // The saved off list first, so a tweak that is off never shows for a moment.
  getStatus()
    .then((s) => s.ui_tweaks_off ?? [], () => [])
    .then((off) => {
      if (unloaded) return;
      setOff(off);
      showTopBarIcon(PLUGIN_NAME, useConnected);
    });
  const paired = addEventListener<[remote: string, clientName?: string]>("decky_toolkit_paired", (remote, clientName) => {
    toast(`${clientName ?? "Client"} paired from ${remote}`);
  });
  // Registered here rather than in the panel so the toast shows while Quick Access is closed.
  const pairRequest = addEventListener<[info: { client_name: string; code: string }]>("decky_toolkit_pair_request", (info) => {
    toaster.toast({
      title: "Decky Toolkit pairing request",
      body: `${info.client_name} wants to pair · code ${info.code}. Open Quick Access → Decky Toolkit to approve.`,
    });
  });
  const inputSession = addEventListener<[remote: string]>("decky_toolkit_input_session", (remote) => {
    toast(`Remote input from ${remote}`);
  });
  routerHook.addRoute(SETTINGS_ROUTE, SettingsPage);
  return {
    name: PLUGIN_NAME,
    titleView: (
      <div className={staticClasses.Title} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: 1, padding: 0 }}>
        <div>Decky Toolkit</div>
        <DialogButton
          style={{ height: "28px", width: "40px", minWidth: 0, padding: "10px 12px", display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => {
            Navigation.CloseSideMenus();
            Navigation.Navigate(SETTINGS_ROUTE);
          }}
        >
          <FaCog style={{ display: "block" }} />
        </DialogButton>
      </div>
    ),
    content: <Panel />,
    icon: <FaPlug />,
    onDismount() {
      // Decky calls this without a try/catch: Steam is restored first and nothing after it may throw.
      unloaded = true;
      restoreAll();
      const steps = [
        () => removeEventListener("decky_toolkit_paired", paired),
        () => removeEventListener("decky_toolkit_pair_request", pairRequest),
        () => removeEventListener("decky_toolkit_input_session", inputSession),
        () => removeEventListener("decky_toolkit_ui_tweaks", tweaksOff),
        () => routerHook.removeRoute(SETTINGS_ROUTE),
      ];
      for (const step of steps) {
        try {
          step();
        } catch (e) {
          console.warn("[Decky Toolkit] unload step failed:", e);
        }
      }
    },
  };
});
