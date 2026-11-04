import {
  ButtonItem,
  Field,
  PanelSection,
  PanelSectionRow,
  ToggleField,
  staticClasses,
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
  pair_url: string;
  pairing_seconds_left: number;
  pairing_count: number;
  stream: { running: boolean; fps: number; subscribers: number; available: boolean; error: string | null } | null;
  error: string | null;
};

const getStatus = callable<[], Status>("get_status");
const setEnabled = callable<[enabled: boolean], Status>("set_enabled");
const regenerateToken = callable<[], Status>("regenerate_token");
const restartServer = callable<[], Status>("restart_server");
const startPairing = callable<[], Status>("start_pairing");
const stopPairing = callable<[], Status>("stop_pairing");

function Content() {
  const [status, setStatus] = useState<Status | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = async () => setStatus(await getStatus());

  const pairing = (status?.pairing_seconds_left ?? 0) > 0;

  useEffect(() => {
    refresh();
    // Poll faster while the pairing countdown is showing.
    const id = setInterval(refresh, pairing ? 1000 : 5000);
    return () => clearInterval(id);
  }, [pairing]);

  const run = async (fn: () => Promise<Status>, okMsg: string) => {
    setBusy(true);
    try {
      setStatus(await fn());
      toaster.toast({ title: "Decky-MCP", body: okMsg });
    } catch (e) {
      toaster.toast({ title: "Decky-MCP error", body: String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <PanelSection>
        <PanelSectionRow>
          <Field label="Status">Loading…</Field>
        </PanelSectionRow>
      </PanelSection>
    );
  }

  const state = !status.enabled ? "Disabled" : status.running ? "Running" : "Stopped";

  return (
    <>
      <PanelSection title="Server">
        <PanelSectionRow>
          <ToggleField
            label="Enable MCP server"
            description={status.error ?? `${state} on ${status.bind}:${status.port}`}
            checked={status.enabled}
            disabled={busy}
            onChange={(v) => run(() => setEnabled(v), v ? "Server enabled" : "Server disabled")}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <Field label="Endpoint" focusable>
            <span style={{ fontFamily: "monospace", fontSize: "0.8em", wordBreak: "break-all" }}>{status.url}</span>
          </Field>
        </PanelSectionRow>
        <PanelSectionRow>
          <Field
            label="Screen viewer"
            description={
              status.stream
                ? status.stream.running
                  ? `Streaming ${status.stream.fps} fps to ${status.stream.subscribers} viewer(s)`
                  : status.stream.available
                    ? "Idle (starts when a browser connects)"
                    : status.stream.error ?? "Unavailable"
                : "Unavailable"
            }
            focusable
          >
            <span style={{ fontFamily: "monospace", fontSize: "0.8em", wordBreak: "break-all" }}>
              {showToken ? status.viewer_url : status.viewer_url.replace(/token=.*/, "token=••••")}
            </span>
          </Field>
        </PanelSectionRow>
        <PanelSectionRow>
          <Field label="Token" focusable onClick={() => setShowToken((s) => !s)}>
            <span style={{ fontFamily: "monospace", fontSize: "0.8em", wordBreak: "break-all" }}>
              {showToken ? status.token : "•••••••• (click to reveal)"}
            </span>
          </Field>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Pairing">
        <PanelSectionRow>
          <ButtonItem
            layout="below"
            disabled={busy || !status.running}
            description={
              pairing
                ? `Open ${status.pair_url} on any device on your network. ${status.pairing_seconds_left}s left, ${status.pairing_count} paired.`
                : "Lets a browser on your network open the viewer without typing the token, for 120 seconds."
            }
            onClick={() =>
              pairing
                ? run(stopPairing, "Pairing closed")
                : run(startPairing, `Pairing open for 120s: visit ${status.pair_url}`)
            }
          >
            {pairing ? "Stop pairing" : "Pair a browser (120 s)"}
          </ButtonItem>
        </PanelSectionRow>
      </PanelSection>

      <PanelSection title="Actions">
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
      </PanelSection>

      <PanelSection title="Connect">
        <PanelSectionRow>
          <div style={{ fontSize: "0.75em", opacity: 0.8 }}>
            From your dev machine:
            <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", fontSize: "0.9em" }}>
              {`claude mcp add --transport http decky ${status.url} -H "Authorization: Bearer <token>"`}
            </pre>
          </div>
        </PanelSectionRow>
      </PanelSection>
    </>
  );
}

export default definePlugin(() => {
  const paired = addEventListener<[remote: string]>("decky_mcp_paired", (remote) => {
    toaster.toast({ title: "Decky-MCP", body: `Browser paired from ${remote}` });
  });
  return {
    name: "Decky-MCP",
    titleView: <div className={staticClasses.Title}>Decky-MCP</div>,
    content: <Content />,
    icon: <FaPlug />,
    onDismount() {
      removeEventListener("decky_mcp_paired", paired);
    },
  };
});
