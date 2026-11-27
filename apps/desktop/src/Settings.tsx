// Settings (⌘, or the gear in the sidebar): how the app looks on this
// device and what the device is called, the open workspace, the GitHub
// account, and what this build is.
import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleUser, FolderOpen, Info, Keyboard, Minus, Plus, SlidersHorizontal, X } from "lucide-react";
import { type DevInfo, type WorkspaceInfo, api, devApi, errorText } from "./api.ts";
import { DeleteWorkspace } from "./DeleteWorkspace.tsx";
import { showInFolderLabel } from "./fileManager.ts";
import { FontChoices } from "./PageStyleMenu.tsx";
import { GitHubSignIn, useGitHubAccount } from "./GitHubSignIn.tsx";
import { Logo, WorkspaceAvatar } from "./Graphics.tsx";
import { pickFolder } from "./menu.ts";
import { pageFont } from "./pageFont.ts";
import { ACCENTS, accent, devLog, spellcheck } from "./preferences.ts";
import { keysLabel, SHORTCUTS } from "./shortcuts.ts";
import { Switch } from "./Switch.tsx";
import { THEMES, type Theme, theme } from "./theme.ts";
import { Welcome } from "./Welcome.tsx";
import { renameTo } from "./WorkspaceName.tsx";
import { useZoom, zoom } from "./zoom.ts";

export type SettingsSection = "preferences" | "workspace" | "account" | "about";

interface SettingsProps {
  /** The section to open on. */
  section?: SettingsSection;
  workspace: WorkspaceInfo;
  onWorkspaceChange: (w: WorkspaceInfo | null) => void;
  /** Saves the open page, then opens the workspace `open` returns. */
  onSwitch: (open: () => Promise<WorkspaceInfo | null>) => Promise<void>;
  onShowShortcuts: () => void;
  onClose: () => void;
}

export function Settings(props: SettingsProps) {
  const [section, setSection] = useState<SettingsSection>(props.section ?? "preferences");
  // Another dialog over this one (signing in, deleting, moving) gets Escape.
  const [covered, setCovered] = useState(false);

  useEffect(() => {
    if (covered) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [covered, props]);

  const nav: { id: SettingsSection; label: string; icon: ReactNode }[] = [
    { id: "preferences", label: "Preferences", icon: <SlidersHorizontal size={16} /> },
    { id: "workspace", label: "Workspace", icon: <WorkspaceAvatar name={props.workspace.name} size={16} /> },
    { id: "account", label: "Account", icon: <CircleUser size={16} /> },
    { id: "about", label: "About", icon: <Info size={16} /> },
  ];

  return (
    <div className="overlay centered" onMouseDown={props.onClose}>
      <div
        className="dialog settings"
        role="dialog"
        aria-label="Settings"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          {nav.map((item) => (
            <button
              key={item.id}
              className={"settings-nav-item" + (item.id === section ? " selected" : "")}
              aria-current={item.id === section ? "page" : undefined}
              onClick={() => setSection(item.id)}
            >
              <span className="settings-nav-icon" aria-hidden>
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button className="icon-button settings-close" aria-label="Close" title="Close (Esc)" onClick={props.onClose}>
            <X size={16} />
          </button>
          {section === "preferences" && <Preferences {...props} />}
          {section === "workspace" && <WorkspaceSettings {...props} setCovered={setCovered} />}
          {section === "account" && <Account {...props} setCovered={setCovered} />}
          {section === "about" && <About onShowShortcuts={props.onShowShortcuts} />}
        </div>
      </div>
    </div>
  );
}

/** A setting: its name and what it does on the left, the control on the right (or below, with `wide`). */
function Row({ label, hint, wide, children }: { label: string; hint?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className={"settings-row" + (wide ? " wide" : "")}>
      <div className="settings-row-text">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

/** This device's name: saved when the field is left (or on Enter), as the workspace's name is. */
function DeviceName({ workspace, onWorkspaceChange }: Pick<SettingsProps, "workspace" | "onWorkspaceChange">) {
  const [name, setName] = useState(workspace.device);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setName(workspace.device), [workspace.device]);

  const save = async () => {
    if (name.trim() === workspace.device) return setName(workspace.device);
    try {
      setProblem(null);
      const changed = await api.setDeviceName(name);
      // Cleared: back to the computer's own name.
      setName(changed.device);
      onWorkspaceChange(changed);
    } catch (e) {
      setProblem(errorText(e));
    }
  };

  return (
    <>
      <Row
        label="Device name"
        hint="Shown next to your name when the same text was edited in two places, so you can tell your devices apart. Clear it to use the computer's own name."
      >
        <input
          className="input settings-input"
          value={name}
          aria-label="Device name"
          maxLength={60}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </Row>
      {problem && <p className="error small">{problem}</p>}
    </>
  );
}

function Preferences(props: Pick<SettingsProps, "workspace" | "onWorkspaceChange">) {
  const chosenTheme = theme.use();
  const chosenAccent = accent.use();
  const font = pageFont.use();
  const level = useZoom();
  const spelling = spellcheck.use();
  return (
    <>
      <h2>Preferences</h2>
      <p className="settings-intro">How Sawmill looks and works on this device. Your other devices keep their own.</p>
      <Row label="Theme" hint="System follows your computer's light and dark mode." wide>
        <div className="theme-choices" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              role="radio"
              aria-checked={t.id === chosenTheme}
              className={"theme-choice" + (t.id === chosenTheme ? " selected" : "")}
              onClick={() => theme.set(t.id)}
            >
              <ThemePreview theme={t.id} />
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </Row>
      <Row label="Accent colour" hint="For buttons, selections and links.">
        <div className="accent-choices" role="radiogroup" aria-label="Accent colour">
          {ACCENTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={a.id === chosenAccent}
              aria-label={a.label}
              title={a.label}
              className={`accent-choice accent-${a.id}` + (a.id === chosenAccent ? " selected" : "")}
              onClick={() => accent.set(a.id)}
            >
              {a.id === chosenAccent && <Check size={13} strokeWidth={3} aria-hidden />}
            </button>
          ))}
        </div>
      </Row>
      <Row
        label="Page font"
        hint="For page titles and text, on every page. Text size and width are set per page, from the Aa button."
        wide
      >
        <FontChoices font={font} onChoose={pageFont.set} />
      </Row>
      <Row label="Zoom" hint={`Makes everything bigger or smaller. Also ${keysLabel("mod+plus")} and ${keysLabel("mod+minus")}.`}>
        <div className="stepper">
          <button className="icon-button" aria-label="Zoom out" onClick={() => zoom("out")}>
            <Minus size={14} />
          </button>
          <button className="stepper-value" title="Actual size" onClick={() => zoom("reset")}>
            {Math.round(level * 100)}%
          </button>
          <button className="icon-button" aria-label="Zoom in" onClick={() => zoom("in")}>
            <Plus size={14} />
          </button>
        </div>
      </Row>

      <h3 className="settings-subtitle">Writing</h3>
      <Row label="Check spelling" hint="Underlines misspelled words as you type, with your computer's own dictionaries.">
        <Switch label="Check spelling" checked={spelling === "on"} onChange={(on) => spellcheck.set(on ? "on" : "off")} />
      </Row>

      <h3 className="settings-subtitle">This device</h3>
      <DeviceName {...props} />
    </>
  );
}

/** A tiny window in the theme's colours; System shows half of each. */
function ThemePreview({ theme }: { theme: Theme }) {
  return (
    <span className={`theme-preview theme-preview-${theme}`} aria-hidden>
      <span className="theme-preview-sidebar">
        <span />
        <span />
        <span />
      </span>
      <span className="theme-preview-page">
        <span className="theme-preview-title" />
        <span />
        <span />
      </span>
    </span>
  );
}

function WorkspaceSettings({
  workspace,
  onWorkspaceChange,
  onSwitch,
  onClose,
  setCovered,
}: SettingsProps & { setCovered: (covered: boolean) => void }) {
  const [name, setName] = useState(workspace.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => setName(workspace.name), [workspace.name]);
  useEffect(() => setCovered(changing || deleting), [changing, deleting, setCovered]);

  const saveName = async () => {
    const next = renameTo(name, workspace.name);
    if (!next) return setName(workspace.name);
    try {
      setProblem(null);
      onWorkspaceChange(await api.renameWorkspace(next));
    } catch (e) {
      setProblem(errorText(e));
    }
  };

  // Moving, closing and deleting reopen the app on another workspace (or
  // none), which closes Settings too.
  const leave = (open: () => Promise<WorkspaceInfo | null>) => {
    onClose();
    void onSwitch(open);
  };

  return (
    <>
      <h2>Workspace</h2>
      <p className="settings-intro">Settings for “{workspace.name}”. The name syncs to all your devices.</p>
      <Row label="Name">
        <input
          className="input settings-input"
          value={name}
          aria-label="Workspace name"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void saveName()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </Row>
      {problem && <p className="error small">{problem}</p>}
      <Row label="Kept in" hint="Where it syncs to reach your other devices.">
        <span className="settings-value" title={workspace.remote ?? undefined}>
          {workspace.keptIn ?? "On this computer"}
        </span>
        <button className="button" onClick={() => setChanging(true)}>
          Change…
        </button>
      </Row>
      <Row label="Folder" hint={<span className="settings-path" title={workspace.path}>{workspace.path}</span>}>
        <button className="button" onClick={() => void api.showWorkspaceFolder()}>
          {showInFolderLabel()}
        </button>
        <button
          className="button"
          title="Move the workspace's files to another folder on this device"
          onClick={() =>
            void (async () => {
              const parent = await pickFolder(`Move “${workspace.name}” into…`);
              if (parent) leave(() => api.moveWorkspace(parent));
            })()
          }
        >
          Move…
        </button>
      </Row>
      <h3 className="settings-subtitle">Leave this workspace</h3>
      <Row label="Close workspace" hint="It stays on this device; open it again from the workspace menu.">
        <button className="button" onClick={() => leave(() => api.closeWorkspace().then(() => null))}>
          Close
        </button>
      </Row>
      <Row label="Delete workspace" hint="Removes it from this device. You choose what happens to other copies.">
        <button className="button danger-outline" onClick={() => setDeleting(true)}>
          Delete…
        </button>
      </Row>

      {changing &&
        createPortal(
          <Welcome
            change={workspace}
            onOpened={(w) => {
              setChanging(false);
              onWorkspaceChange(w);
            }}
            onCancel={() => setChanging(false)}
          />,
          document.body,
        )}
      {deleting && (
        <DeleteWorkspace
          onDelete={async (deleted) => {
            onClose();
            await onSwitch(deleted);
          }}
          onClose={() => setDeleting(false)}
        />
      )}
    </>
  );
}

/** The name the user's edits are by: saved when the field is left (or on Enter). */
function PersonName({ workspace, onWorkspaceChange }: Pick<SettingsProps, "workspace" | "onWorkspaceChange">) {
  const [name, setName] = useState(workspace.person ?? "");
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setName(workspace.person ?? ""), [workspace.person]);

  const save = async () => {
    if (name.trim() === (workspace.person ?? "")) return setName(workspace.person ?? "");
    try {
      setProblem(null);
      const changed = await api.setPersonName(name);
      // Cleared: back to the name from GitHub or Git, if there is one.
      setName(changed.person ?? "");
      onWorkspaceChange(changed);
    } catch (e) {
      setProblem(errorText(e));
    }
  };

  return (
    <>
      <Row
        label="Your name"
        hint="Shown with your edits when the same text was edited in two places. Filled in from GitHub or Git; clear it to use that again."
      >
        <input
          className="input settings-input"
          value={name}
          placeholder="Not set"
          aria-label="Your name"
          maxLength={60}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => void save()}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </Row>
      {problem && <p className="error small">{problem}</p>}
    </>
  );
}

function Account({
  workspace,
  onWorkspaceChange,
  setCovered,
}: Pick<SettingsProps, "workspace" | "onWorkspaceChange"> & { setCovered: (covered: boolean) => void }) {
  const [user, setUserState] = useGitHubAccount();
  const [signingIn, setSigningIn] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setCovered(signingIn), [signingIn, setCovered]);
  // Signing in or out can change the name filled in.
  const setUser = (u: Parameters<typeof setUserState>[0]) => {
    setUserState(u);
    void api.workspaceInfo().then((w) => w && onWorkspaceChange(w));
  };

  return (
    <>
      <h2>Account</h2>
      <p className="settings-intro">
        Sawmill has no account of its own. Signing in with GitHub lets you keep workspaces there, and your edits are
        signed with your name.
      </p>
      <PersonName workspace={workspace} onWorkspaceChange={onWorkspaceChange} />
      {user === undefined ? null : user ? (
        <div className="account-card">
          <img className="avatar" src={user.avatarUrl} alt="" width={44} height={44} />
          <div className="account-text">
            <div className="account-name">{user.name?.trim() || user.login}</div>
            <div className="muted small">Signed in to GitHub as @{user.login}</div>
          </div>
          <button
            className="button"
            title="Sign out on this device. Commits from now on are by this device."
            onClick={() =>
              void api
                .githubSignOut()
                .then(() => setUser(null))
                .catch((e) => setProblem(errorText(e)))
            }
          >
            Sign out
          </button>
        </div>
      ) : (
        <div className="account-card">
          <span className="choice-icon tint-accent" aria-hidden>
            <CircleUser size={20} />
          </span>
          <div className="account-text">
            <div className="account-name">Not signed in</div>
            <div className="muted small">Your workspaces work without it, in folders you choose.</div>
          </div>
          <button className="button primary" onClick={() => setSigningIn(true)}>
            Sign in with GitHub
          </button>
        </div>
      )}
      {problem && <p className="error small">{problem}</p>}
      {signingIn && (
        <GitHubSignIn
          onDone={(u) => {
            setSigningIn(false);
            setUser(u);
          }}
          onClose={() => setSigningIn(false)}
        />
      )}
    </>
  );
}

function About({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const [info, setInfo] = useState<DevInfo | null>(null);
  const logOn = devLog.use();
  useEffect(() => {
    devApi.info().then(setInfo, () => setInfo(null));
  }, []);
  return (
    <>
      <div className="about-head">
        <Logo size={56} />
        <div>
          <h2>Sawmill</h2>
          <div className="muted">
            Version {info?.version ?? "…"}
            {info?.debugBuild ? " (debug build)" : ""}
          </div>
        </div>
      </div>
      <p className="settings-intro">
        A free, open-source workspace for humans and AI agents. Your pages are plain files in a Git repository you own.
      </p>
      <Row label="System">
        <span className="settings-value">{info?.os ?? "…"}</span>
      </Row>
      <Row label="Git" hint="Sawmill uses Git to keep every version of your pages.">
        <span className="settings-value">{info ? (info.git ?? "Not found") : "…"}</span>
      </Row>
      <Row
        label="Developer panel"
        hint={
          info?.enabled
            ? `Always available in this build. ${keysLabel(SHORTCUTS.toggleDevPanel.keys)} opens it.`
            : `A live log of what the app does, to copy into a bug report, and the workspace's databases. ${keysLabel(SHORTCUTS.toggleDevPanel.keys)} opens it.`
        }
      >
        <Switch
          label="Developer panel"
          checked={!!info?.enabled || logOn === "on"}
          disabled={!!info?.enabled}
          onChange={(on) => devLog.set(on ? "on" : "off")}
        />
      </Row>
      <Row label="Log file" hint="What the app did, without the text of your pages. Attach it to a bug report.">
        <button className="button" onClick={() => void devApi.showLogFile().catch(() => {})}>
          <FolderOpen size={15} aria-hidden /> {showInFolderLabel()}
        </button>
      </Row>
      <Row label="Keyboard shortcuts" hint="Every shortcut, in one place.">
        <button className="button" onClick={onShowShortcuts}>
          <Keyboard size={15} aria-hidden /> Show <kbd>{keysLabel(SHORTCUTS.showShortcuts.keys)}</kbd>
        </button>
      </Row>
    </>
  );
}
