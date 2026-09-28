import { useState } from "react";
import { t } from "../i18n/index.js";
import { Button } from "../ui/Button.js";
import { Dialog } from "../ui/Dialog.js";
import { LinkRow } from "../ui/List.js";

/** Bundled with the client so it can be read before connecting, even offline. */
export function PrivacyButton({ row = false }: { row?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    {row ? <LinkRow label={t("app.privacy.title")} onClick={() => setOpen(true)} /> : <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>{t("app.privacy.title")}</Button>}
    <Dialog open={open} title={t("app.privacy.title")} onClose={() => setOpen(false)} footer={<Button onClick={() => setOpen(false)}>{t("common.close")}</Button>}>
      {open ? <iframe title={t("app.privacy.frame")} src="./privacy.html" style={{ width: "100%", height: "60dvh", border: 0 }} /> : null}
    </Dialog>
  </>;
}
