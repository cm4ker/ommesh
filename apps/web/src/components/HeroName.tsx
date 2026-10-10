import { useEffect, useState } from "react";
import { toast } from "../lib/toast.js";
import { CheckIcon, CopyIcon } from "./Icons.js";
import { t } from "../i18n/index.js";

/**
 * Puts a node's or a channel's name on the clipboard. The note under "Copied"
 * repeats the name, so the reader sees what went, emoji and odd letters too.
 */
export function copyName(name: string, done?: () => void): void {
  void navigator.clipboard?.writeText(name).then(() => {
    toast(t("common.copied"), "", undefined, name);
    done?.();
  });
}

/**
 * The name at the top of a profile or a channel's page. The name and the copy
 * mark after it are one button, so a tap on either copies the name; the mark
 * turns into a tick for a moment after.
 */
export function HeroName({ name, label }: { name: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <h1>
      <button type="button" className="hero-name" title={label} onClick={() => copyName(name, () => setCopied(true))}>
        <span className="hero-name-text">{name}</span>
        {copied ? <CheckIcon size={16} className="hero-copy done" /> : <CopyIcon size={16} className="hero-copy" />}
      </button>
    </h1>
  );
}
