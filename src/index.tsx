import {
  ConfirmModal,
  DialogBody,
  DialogButton,
  DialogButtonPrimary,
  DialogControlsSection,
  DialogControlsSectionHeader,
  Field,
  Focusable,
  Navigation,
  TextField,
  ToggleField,
  showModal,
  staticClasses,
} from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, routerHook, toaster } from "@decky/api";
import { ReactNode, useEffect, useState } from "react";
import { FaCog, FaPlug } from "react-icons/fa";
import { Mark } from "./Mark";

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
};

type InputSettings = { enabled: boolean; backend: "ei" | "uinput" | null; available: boolean; reason: string | null };

const SETTINGS_ROUTE = "/decky-toolkit/settings";
const MUTED = "#8b929a";
const LINK = "#1a9fff";
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

  const refresh = async () => setStatus(await getStatus());
  const refreshRequests = async () => setRequests(await listPairRequests());
  const pending = requests.filter((r) => r.status === "pending").sort((a, b) => b.age_s - a.age_s);

  useEffect(() => {
    const onInput = addEventListener<[enabled: boolean]>("decky_toolkit_input_state", () => refresh());
    const onRequest = addEventListener<[info: unknown]>("decky_toolkit_pair_request", () => refreshRequests());
    const onRequests = addEventListener<[list: PairRequest[]]>("decky_toolkit_pair_requests", setRequests);
    const onClients = addEventListener<[list: PairedClient[]]>("decky_toolkit_paired_clients", setClients);
    listPairedClients().then(setClients);
    refresh();
    const id = setInterval(refresh, 5000);
    return () => {
      clearInterval(id);
      removeEventListener("decky_toolkit_input_state", onInput);
      removeEventListener("decky_toolkit_pair_request", onRequest);
      removeEventListener("decky_toolkit_pair_requests", onRequests);
      removeEventListener("decky_toolkit_paired_clients", onClients);
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
  };
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
          <li>In the extension, add the address shown in this panel.</li>
          <li>A request appears here. Approve it if its code matches the one on your computer.</li>
        </ol>
      }
    />,
  );

const STYLE = `
.dtk-card { border-radius: 4px; background: rgba(255,255,255,0.04); transition: background 0.15s; }
.dtk-card.dtk-focus { background: rgba(255,255,255,0.16); }
.dtk-link.dtk-focus { text-decoration: underline; color: #fff !important; }
`;

function Centered({ children }: { children: ReactNode }) {
  return (
    <Focusable
      flow-children="column"
      style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "16px", padding: "24px 16px 16px" }}
    >
      <style>{STYLE}</style>
      <Mark size={96} style={{ color: "#7a7f86", marginBottom: "8px" }} />
      {children}
      <Focusable
        className="dtk-link"
        focusClassName="dtk-focus"
        noFocusRing
        onActivate={showPairingHelp}
        onClick={showPairingHelp}
        style={{ color: LINK, fontSize: "15px", padding: "4px 8px", cursor: "pointer" }}
      >
        How pairing works
      </Focusable>
    </Focusable>
  );
}

const hint = { color: MUTED, fontSize: "15px", lineHeight: 1.45, margin: 0, maxWidth: "260px" } as const;

function Panel() {
  const { status, pending, busy, decide } = useToolkit();
  const current = pending[0];

  if (current) {
    return (
      <Centered>
        <DialogButtonPrimary style={{ width: "100%" }} disabled={busy} onClick={() => decide(current, true)}>
          Approve {current.client_name}
        </DialogButtonPrimary>
        <div style={{ color: MUTED, fontSize: "14px", marginTop: "-6px" }}>
          Code <span style={{ color: "#fff", fontSize: "18px", fontWeight: 600, letterSpacing: "0.12em" }}>{current.code}</span>
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

  const up = status.enabled && status.running && !status.error;
  return (
    <Centered>
      <Focusable
        className="dtk-card"
        focusClassName="dtk-focus"
        noFocusRing
        onActivate={() => {}}
        style={{ width: "100%", padding: "14px 8px", boxSizing: "border-box" }}
      >
        <div style={{ fontSize: "26px", fontWeight: 600, color: up ? "#fff" : MUTED, letterSpacing: "0.02em" }}>{status.ip}</div>
        <div style={{ fontSize: "14px", color: MUTED, marginTop: "2px" }}>port {status.port}</div>
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

  return (
    <div style={{ marginTop: "40px", height: "calc(100% - 40px)", overflowY: "auto" }}>
      <DialogBody>
        <DialogControlsSection>
          <DialogControlsSectionHeader>Server</DialogControlsSectionHeader>
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
          <Field label="Address" focusable>
            {status ? `${status.ip}:${status.port}` : "…"}
          </Field>
          <TextField
            label="Port"
            description="1024-65535. Changing it restarts the server."
            mustBeNumeric
            rangeMin={1024}
            rangeMax={65535}
            value={port}
            disabled={busy || !status}
            onChange={(e) => setPortDraft(e.target.value)}
            onBlur={applyPort}
            onKeyDown={(e) => e.key === "Enter" && applyPort()}
          />
          <Field label="Restart server" description="Stops and starts the server; connected computers reconnect.">
            <DialogButton style={{ minWidth: "160px" }} disabled={busy} onClick={() => run(restartServer, "Server restarted")}>
              Restart
            </DialogButton>
          </Field>
        </DialogControlsSection>

        <DialogControlsSection>
          <DialogControlsSectionHeader>Remote input</DialogControlsSectionHeader>
          <ToggleField
            label="Allow remote input"
            description={
              status?.input && !status.input.available
                ? status.input.reason ?? "Unavailable"
                : "Lets paired computers send keyboard, mouse and controller input."
            }
            checked={!!status?.input?.enabled}
            disabled={busy || !status?.input?.available}
            onChange={setInput}
          />
        </DialogControlsSection>

        <DialogControlsSection>
          <DialogControlsSectionHeader>Paired clients</DialogControlsSectionHeader>
          {clients.length === 0 && <Field label="None yet" focusable />}
          {clients.map((c) => (
            <Field key={c.fingerprint} label={c.name} description={`${KIND_LABELS[c.kind] ?? c.kind} · ${lastSeen(c.last_seen)}`}>
              <DialogButton style={{ minWidth: "160px" }} disabled={busy} onClick={() => forget(c)}>
                Forget
              </DialogButton>
            </Field>
          ))}
        </DialogControlsSection>
      </DialogBody>
    </div>
  );
}

export default definePlugin(() => {
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
    name: "Decky Toolkit",
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
      removeEventListener("decky_toolkit_paired", paired);
      removeEventListener("decky_toolkit_pair_request", pairRequest);
      removeEventListener("decky_toolkit_input_session", inputSession);
      routerHook.removeRoute(SETTINGS_ROUTE);
    },
  };
});
