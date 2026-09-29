import { useState, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes } from "react";
import { CloseIcon, EyeIcon, EyeOffIcon, SearchIcon } from "../components/Icons.js";
import { t } from "../i18n/index.js";

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

/** A password field with an eye at its end that shows what was typed, and hides it again. */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [shown, setShown] = useState(false);
  const label = shown ? t("common.hidePassword") : t("common.showPassword");
  return (
    <span className="input-reveal">
      <input className="input" type={shown ? "text" : "password"} autoCapitalize="off" autoCorrect="off" spellCheck={false} {...props} />
      {/* Pressing it keeps the focus, and a phone's keyboard, in the field. */}
      <button type="button" className="input-reveal-button" aria-label={label} title={label} aria-pressed={shown} onMouseDown={(e) => e.preventDefault()} onClick={() => setShown(!shown)}>
        {shown ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
      </button>
    </span>
  );
}

/**
 * A search field: the magnifier, what is typed, and once something is, a cross that empties it (#44). A note, such
 * as how many the list shows, sits at its end, before the cross.
 */
export function SearchField({ value, onValue, note, ref, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange"> & { value: string; onValue: (next: string) => void; note?: ReactNode; ref?: Ref<HTMLInputElement> | undefined }) {
  return (
    <label className="search">
      <SearchIcon size={15} />
      <input ref={ref} value={value} onChange={(e) => onValue(e.target.value)} {...rest} />
      {note}
      {value ? (
        // Pressing it keeps the focus, and a phone's keyboard, where it was.
        <button type="button" className="search-clear" aria-label={t("common.clear")} title={t("common.clear")} onMouseDown={(e) => e.preventDefault()} onClick={() => onValue("")}>
          <CloseIcon size={14} />
        </button>
      ) : null}
    </label>
  );
}

export function Select({ children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  return (
    <select className="input select" {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (next: boolean) => void; hint?: ReactNode }) {
  return (
    <label className="toggle">
      <span className="toggle-text">
        <span>{label}</span>
        {hint ? <span className="field-hint">{hint}</span> : null}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

/** A row in a settings section: a label on the left, the value or control on the right. */
export function Row({ label, children, onClick }: { label: ReactNode; children?: ReactNode; onClick?: (() => void) | undefined }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag className={["kv", onClick ? "kv-action" : ""].join(" ")} type={onClick ? "button" : undefined} onClick={onClick}>
      <span className="kv-label">{label}</span>
      <span className="kv-value">{children}</span>
    </Tag>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-head">
        <h2>{title}</h2>
        {actions ? <span className="section-actions">{actions}</span> : null}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}
