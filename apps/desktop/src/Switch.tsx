/** An on/off switch, for settings that are either on or off. */
export function Switch({
  checked,
  onChange,
  disabled,
  label,
  labelledBy,
  role = "switch",
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Its name, when no visible text names it (`labelledBy`). */
  label?: string;
  labelledBy?: string;
  /** "menuitemcheckbox" in a menu. */
  role?: "switch" | "menuitemcheckbox";
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      aria-label={label}
      aria-labelledby={labelledBy}
      disabled={disabled}
      className={"switch" + (checked ? " on" : "")}
      onClick={() => onChange(!checked)}
    >
      <span className="switch-thumb" aria-hidden />
    </button>
  );
}
