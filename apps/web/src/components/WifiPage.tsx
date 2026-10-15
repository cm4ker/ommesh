import { useEffect, useState, type FormEvent } from "react";
import { WIFI_PASSWORD_MAX, WIFI_SSID_MAX, type RadioWifi } from "@meshnet/meshcore";
import { session, useSession } from "../lib/session.js";
import { act, toast } from "../lib/toast.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { Input, PasswordInput } from "../ui/Field.js";
import { Group, InfoRow, LinkRow, SwitchRow } from "../ui/List.js";
import { AlertIcon, CopyIcon, RefreshIcon } from "./Icons.js";
import { t } from "../i18n/index.js";
import { errorText } from "../i18n/errors.js";

/**
 * The radio's Wi-Fi (MeshCore 1.18), through its own console: on or off,
 * the network and its password, and where it is now. The radio takes what
 * is written at its next start, so a change waits for a reboot, which the
 * page offers on top until then.
 */
export function WifiPage({ online }: { online: boolean }) {
  const wifi = useSession().wifi;
  const [editing, setEditing] = useState(false);
  const [rebooting, setRebooting] = useState(false);

  // Where the radio is now is read again each time the page opens.
  useEffect(() => {
    if (online) void session.readWifi().catch(() => undefined);
  }, [online]);

  if (!wifi) return <p className="group-note">{t("radio.wifi.none")}</p>;
  return (
    <>
      {wifi.pending ? (
        <Group>
          <div className="line wifi-pending">
            <AlertIcon size={16} className="wifi-pending-mark" />
            <span className="line-text">{t("radio.wifi.pending")}</span>
            <Button
              size="sm"
              disabled={!online || rebooting}
              onClick={() => {
                setRebooting(true);
                void act(() => session.reboot(), t("radio.wifi.rebooting")).finally(() => setRebooting(false));
              }}
            >
              <RefreshIcon size={15} />
              {t("radio.wifi.reboot")}
            </Button>
          </div>
        </Group>
      ) : null}
      <Group>
        <SwitchRow label={t("radio.wifi.switch")} checked={wifi.enabled} disabled={!online} onChange={(on) => void act(() => session.setWifiEnabled(on))} />
      </Group>
      <Group title={t("radio.wifi.network")}>
        <LinkRow label={t("radio.wifi.network")} value={wifi.ssid ?? t("radio.wifi.notSet")} disabled={!online} onClick={() => setEditing(true)} />
        <LinkRow label={t("radio.wifi.password")} value={wifi.ssid ? "••••••••" : t("radio.wifi.notSet")} disabled={!online} onClick={() => setEditing(true)} />
      </Group>
      {wifi.enabled ? <NowGroup wifi={wifi} /> : null}
      <NetworkDialog open={editing} wifi={wifi} onClose={() => setEditing(false)} />
    </>
  );
}

function NowGroup({ wifi }: { wifi: RadioWifi }) {
  return (
    <Group title={t("radio.wifi.now")}>
      <InfoRow label={t("radio.wifi.state")}>
        <span className="wifi-state">
          {wifi.connected ? <span className="wifi-dot" aria-hidden="true" /> : null}
          {wifi.connected ? t("radio.wifi.connected") : t("radio.wifi.disconnected")}
        </span>
      </InfoRow>
      {wifi.ip ? (
        <LinkRow
          label={t("radio.wifi.address")}
          value={<span className="mono">{wifi.ip}</span>}
          trailing={<CopyIcon size={14} className="line-chev" />}
          onClick={() => void navigator.clipboard?.writeText(wifi.ip ?? "").then(() => toast(t("common.copied")))}
        />
      ) : null}
    </Group>
  );
}

/** The network and its password in one window: the firmware takes both. The kept password is read from the radio when it opens. */
function NetworkDialog({ open, wifi, onClose }: { open: boolean; wifi: RadioWifi; onClose: () => void }) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSsid(wifi.ssid ?? "");
    setPassword("");
    setError(null);
    let alive = true;
    if (wifi.ssid) void session.readWifiPassword().then((kept) => alive && setPassword((typed) => typed || kept), () => undefined);
    return () => {
      alive = false;
    };
    // Filled once as the window opens; what the reader types is theirs after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const name = ssid.trim();
  const fault = !name ? t("radio.wifi.ssidEmpty") : name.length > WIFI_SSID_MAX ? t("radio.wifi.ssidLong", { max: WIFI_SSID_MAX }) : password.length > WIFI_PASSWORD_MAX ? t("radio.wifi.passwordLong", { max: WIFI_PASSWORD_MAX }) : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (fault) return setError(fault);
    setBusy(true);
    try {
      await session.setWifiNetwork(name, password);
      toast(t("radio.wifi.saved"));
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title={t("radio.wifi.sheetTitle")} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)}>
        <label className="field">
          <span className="field-label">{t("radio.wifi.ssidLabel")}</span>
          <Input value={ssid} onChange={(e) => setSsid(e.target.value)} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        </label>
        <label className="field">
          <span className="field-label">{t("radio.wifi.password")}</span>
          <PasswordInput value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" />
        </label>
        {error ? <p className="connect-error">{error}</p> : null}
        <div className="dialog-foot">
          <Button onClick={onClose}>{t("common.cancel")}</Button>
          <Button variant="primary" type="submit" busy={busy}>
            {t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
