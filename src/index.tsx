import {
  ButtonItem,
  DialogButton,
  Field,
  Focusable,
  PanelSection,
  PanelSectionRow,
  ToggleField,
} from "@decky/ui";
import { addEventListener, callable, definePlugin, removeEventListener, toaster } from "@decky/api";
import { useEffect, useState } from "react";
import { FaPlug } from "react-icons/fa";

type Status = {
  enabled: boolean;
  running: boolean;
  bind: string;
  port: number;
  token: string;
  ip: string;
  url: string;
  viewer_url: string;
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

type InputSettings = { enabled: boolean; backend: "ei" | "uinput" | null; available: boolean; reason: string | null };

const getStatus = callable<[], Status>("get_status");
const setEnabled = callable<[enabled: boolean], Status>("set_enabled");
const regenerateToken = callable<[], Status>("regenerate_token");
const restartServer = callable<[], Status>("restart_server");
const listPairRequests = callable<[], PairRequest[]>("list_pair_requests");
const approvePairRequest = callable<[id: string], PairRequest[]>("approve_pair_request");
const denyPairRequest = callable<[id: string], PairRequest[]>("deny_pair_request");
const getInputSettings = callable<[], InputSettings>("get_input_settings");
const setInputEnabled = callable<[enabled: boolean], InputSettings>("set_input_enabled");

function Content() {
  const [status, setStatus] = useState<Status | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);

  const [requests, setRequests] = useState<PairRequest[]>([]);

  const refresh = async () => setStatus(await getStatus());
  const refreshRequests = async () => setRequests(await listPairRequests());

  const pending = requests.filter((r) => r.status === "pending");

  useEffect(() => {
    const onInput = addEventListener<[enabled: boolean]>("decky_toolkit_input_state", () => refresh());
    const onRequest = addEventListener<[info: unknown]>("decky_toolkit_pair_request", () => refreshRequests());
    const onRequests = addEventListener<[list: PairRequest[]]>("decky_toolkit_pair_requests", (list) => setRequests(list));
    return () => {
      removeEventListener("decky_toolkit_input_state", onInput);
      removeEventListener("decky_toolkit_pair_request", onRequest);
      removeEventListener("decky_toolkit_pair_requests", onRequests);
    };
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    refreshRequests();
    const id = setInterval(refreshRequests, pending.length ? 2000 : 10000);
    return () => clearInterval(id);
  }, [pending.length > 0]);

  const decide = async (r: PairRequest, allow: boolean) => {
    setBusy(true);
    try {
      setRequests(await (allow ? approvePairRequest(r.id) : denyPairRequest(r.id)));
      toaster.toast({ title: "Decky Toolkit", body: `${allow ? "Approved" : "Denied"} ${r.client_name}` });
    } catch (e) {
      toaster.toast({ title: "Decky Toolkit error", body: String(e) });
      refreshRequests();
    } finally {
      setBusy(false);
    }
  };

  const run = async (fn: () => Promise<Status>, okMsg: string) => {
    setBusy(true);
    try {
      setStatus(await fn());
      toaster.toast({ title: "Decky Toolkit", body: okMsg });
    } catch (e) {
      toaster.toast({ title: "Decky Toolkit error", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  // Oldest first; one at a time so the owner always sees which client the code belongs to.
  const current = [...pending].sort((a, b) => b.age_s - a.age_s)[0];
  if (current) {
    return (
      <PanelSection title="Pairing">
        <PanelSectionRow>
          <Field label={current.client_name} description={`${current.remote} · code ${current.code}`} focusable bottomSeparator="none" />
        </PanelSectionRow>
        <PanelSectionRow>
          <Focusable style={{ display: "flex", gap: "8px" }}>
            <DialogButton style={{ flex: 1, minWidth: 0 }} disabled={busy} onClick={() => decide(current, true)}>
              Approve
            </DialogButton>
            <DialogButton style={{ flex: 1, minWidth: 0 }} disabled={busy} onClick={() => decide(current, false)}>
              Deny
            </DialogButton>
          </Focusable>
        </PanelSectionRow>
        {pending.length > 1 && (
          <PanelSectionRow>
            <Field label="Requests" focusable>{`1 of ${pending.length}`}</Field>
          </PanelSectionRow>
        )}
      </PanelSection>
    );
  }

  if (!status) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <Field label="Status">Loading…</Field>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const serverState = status.error ?? (!status.enabled ? "disabled" : status.running ? "running" : "stopped");

  return (
    <>
      <PanelSection title="Connect">
        <PanelSectionRow>
          <Field label={status.ip} description={`Port ${status.port} · add this address in the Decky Toolkit extension`} focusable />
        </PanelSectionRow>
        <PanelSectionRow>
          <Field label="Server" focusable>{serverState}</Field>
        </PanelSectionRow>
        <PanelSectionRow>
          <ButtonItem layout="below" onClick={() => setShowAdvanced((s) => !s)}>
            {showAdvanced ? "Hide advanced" : "Advanced"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      {showAdvanced && (
        <PanelSection title="Advanced">
          <PanelSectionRow>
            <ToggleField
              label="Enable MCP server"
              checked={status.enabled}
              disabled={busy}
              onChange={(v) => run(() => setEnabled(v), v ? "Server enabled" : "Server disabled")}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ToggleField
              label="Allow remote input"
              description={status.input && !status.input.available ? status.input.reason ?? "Unavailable" : undefined}
              checked={!!status.input?.enabled}
              disabled={busy || !status.input?.available}
              onChange={async (v) => {
                setBusy(true);
                try {
                  await setInputEnabled(v);
                  const input = await getInputSettings();
                  setStatus((s) => (s ? { ...s, input } : s));
                } catch (e) {
                  toaster.toast({ title: "Decky Toolkit error", body: String(e) });
                } finally {
                  setBusy(false);
                }
              }}
            />
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => run(restartServer, "Server restarted")}>
              Restart server
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <ButtonItem layout="below" disabled={busy} onClick={() => run(regenerateToken, "New token generated")}>
              Regenerate token
            </ButtonItem>
          </PanelSectionRow>
          <PanelSectionRow>
            <Field label="Viewer URL and token" focusable onClick={() => setShowToken((s) => !s)}>
              <span style={{ fontFamily: "monospace", fontSize: "0.8em", wordBreak: "break-all" }}>
                {showToken ? status.viewer_url : "•••••••• (click to reveal)"}
              </span>
            </Field>
          </PanelSectionRow>
        </PanelSection>
      )}
    </>
  );
}

export default definePlugin(() => {
  const paired = addEventListener<[remote: string, clientName?: string]>("decky_toolkit_paired", (remote, clientName) => {
    toaster.toast({ title: "Decky Toolkit", body: `${clientName ?? "Client"} paired from ${remote}` });
  });
  // Registered here rather than in the panel so the toast shows while Quick Access is closed.
  const pairRequest = addEventListener<[info: { client_name: string; code: string }]>("decky_toolkit_pair_request", (info) => {
    toaster.toast({
      title: "Decky Toolkit pairing request",
      body: `${info.client_name} wants to pair · code ${info.code}. Open Quick Access → Decky Toolkit to approve.`,
    });
  });
  const inputSession = addEventListener<[remote: string]>("decky_toolkit_input_session", (remote) => {
    toaster.toast({ title: "Decky Toolkit", body: `Remote input from ${remote}` });
  });
  return {
    name: "Decky Toolkit",
    content: <Content />,
    icon: <FaPlug />,
    onDismount() {
      removeEventListener("decky_toolkit_paired", paired);
      removeEventListener("decky_toolkit_pair_request", pairRequest);
      removeEventListener("decky_toolkit_input_session", inputSession);
    },
  };
});
