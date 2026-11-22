import { type ReactNode, useCallback, useEffect, useState } from "react";
import { ArrowLeft, ChevronRight, FolderSearch, FolderSync, GitBranch, LogIn, Plus, X } from "lucide-react";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type CloudFolder,
  type CloudFolders,
  type FolderPlace,
  type FoundWorkspace,
  type GitHubAccess,
  type GitHubUser,
  type RemoteWorkspace,
  type WorkspaceEntry,
  type WorkspaceInfo,
  api,
  errorText,
} from "./api.ts";
import { GitHubSignIn, useGitHubAccount } from "./GitHubSignIn.tsx";
import { pickFolder } from "./menu.ts";
import { folderOfRemote, isFolderRemote } from "./remotes.ts";

/** The workspaces to offer on the welcome screen: the known ones except the open one. */
export function otherWorkspaces(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return entries.filter((e) => !e.current);
}

/** "iCloud Drive", "iCloud Drive or Dropbox", "iCloud Drive, Dropbox or OneDrive". */
export function cloudNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

/** Workspaces in cloud folders that this device doesn't have yet. */
export function joinableInCloud(found: FoundWorkspace[], known: WorkspaceEntry[]): FoundWorkspace[] {
  const names = new Set(known.filter((k) => !k.missing).map((k) => k.name.toLowerCase()));
  return found.filter((f) => !names.has(f.name.toLowerCase()));
}

/** Workspaces on GitHub that this device doesn't have yet. */
export function joinable(remote: RemoteWorkspace[], known: WorkspaceEntry[]): RemoteWorkspace[] {
  const names = new Set(known.filter((k) => !k.missing).map((k) => k.name.toLowerCase()));
  return remote.filter((r) => !names.has(r.name.toLowerCase()));
}

/**
 * Starting a new workspace, joining one from another device, or changing
 * where the open one is kept.
 */
export type Intent = "new" | "join" | "change";

type Step = { k: "start" } | { k: "new" } | { k: "join" } | { k: "change" };

/** The two kinds of place a workspace is kept in. */
type Kind = "folder" | "git";

type Run = (task: () => Promise<WorkspaceInfo | null>) => Promise<void>;

/**
 * "Add a workspace": shown when no workspace is open, over the open one for
 * "Add workspace…" (with `onCancel`), and with `change` to choose where the
 * open workspace is kept.
 *
 * A workspace is kept in one of two kinds of place:
 * - **A folder.** "On this computer" by default. A folder the user picks
 *   gets a `<name>.docsync` folder that this device syncs through; in
 *   Dropbox, OneDrive or iCloud Drive that puts it on every device. By
 *   default there's no such folder at all, just this device's copy, which
 *   users don't need to know.
 * - **A Git repository:** GitHub, or any Git URL.
 *
 * The pages themselves always live in the app's data folder, with their
 * whole history.
 */
export function Welcome({
  onOpened,
  onCancel,
  change,
}: {
  onOpened: (w: WorkspaceInfo) => void;
  onCancel?: () => void;
  /** The open workspace, to change where it's kept. */
  change?: WorkspaceInfo;
}) {
  const [path, setPath] = useState<Step[]>(() => [change ? { k: "change" } : { k: "start" }]);
  const step = path[path.length - 1]!;
  const go = (next: Step) => {
    setError(null);
    setPath((p) => [...p, next]);
  };
  const back = () => {
    setError(null);
    setPath((p) => (p.length > 1 ? p.slice(0, -1) : p));
  };

  const [name, setName] = useState(change?.name ?? "My Notes");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [known, setKnown] = useState<WorkspaceEntry[]>([]);
  const [cloud, setCloud] = useState<CloudFolders | null>(null);

  const loadKnown = useCallback(
    () =>
      api
        .listWorkspaces()
        .then(setKnown)
        .catch(() => setKnown([])),
    [],
  );
  useEffect(() => void loadKnown(), [loadKnown]);
  useEffect(() => {
    void api.cloudFolders().then(setCloud, () => setCloud({ folders: [], workspaces: [] }));
  }, []);

  useEffect(() => {
    if (!onCancel) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const run: Run = async (task) => {
    setBusy(true);
    setError(null);
    try {
      const workspace = await task();
      if (workspace) onOpened(workspace);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const display = name.trim() || "My Notes";
  const folders = cloud?.folders ?? [];
  const ctx: StepProps = { name: display, known, cloud, folders, busy, run, setError };

  let body: ReactNode;
  switch (step.k) {
    case "start":
      body = (
        <StartStep
          title={onCancel ? "Add a workspace" : "Welcome to Pagemesh"}
          // Adding is only about adding: the switcher lists the others.
          showKnown={!onCancel}
          known={known}
          busy={busy}
          run={run}
          loadKnown={loadKnown}
          onNew={() => go({ k: "new" })}
          onJoin={() => go({ k: "join" })}
        />
      );
      break;
    case "new":
      body = <NewStep {...ctx} rawName={name} setName={setName} />;
      break;
    case "join":
      body = <JoinStep {...ctx} />;
      break;
    case "change":
      body = change && <ChangeStep {...ctx} workspace={change} />;
      break;
  }

  return (
    <div className={"welcome-screen" + (onCancel ? " over-workspace" : "")}>
      <div className="welcome">
        {/* No title bar here: the top of the window still moves it. */}
        <div className="window-drag" data-window-drag />
        <div className="wizard-nav">
          {path.length > 1 ? (
            <button type="button" className="link wizard-back" onClick={back} disabled={busy}>
              <ArrowLeft size={14} /> Back
            </button>
          ) : (
            <span />
          )}
          {onCancel ? (
            <button className="icon-button" aria-label="Close" title="Close (Esc)" onClick={onCancel}>
              <X size={16} />
            </button>
          ) : (
            <span />
          )}
        </div>
        {body}
        {busy && <p className="muted">Working…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

interface StepProps {
  name: string;
  known: WorkspaceEntry[];
  cloud: CloudFolders | null;
  folders: CloudFolder[];
  busy: boolean;
  run: Run;
  setError: (e: string | null) => void;
}

function Choices({ children }: { children: ReactNode }) {
  return <div className="choices">{children}</div>;
}

function Choice({
  icon,
  title,
  text,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="choice" disabled={disabled} onClick={onClick}>
      <span className="choice-icon" aria-hidden>
        {icon}
      </span>
      <span className="choice-text">
        <span className="choice-title">{title}</span>
        <span className="muted small">{text}</span>
      </span>
      <ChevronRight size={16} className="muted" aria-hidden />
    </button>
  );
}

/** The first screen: new or join, and on the welcome screen the workspaces this device knows. */
function StartStep({
  title,
  showKnown,
  known,
  busy,
  run,
  loadKnown,
  onNew,
  onJoin,
}: {
  title: string;
  /** List the workspaces this device knows, to open one. */
  showKnown: boolean;
  known: WorkspaceEntry[];
  busy: boolean;
  run: Run;
  loadKnown: () => void;
  onNew: () => void;
  onJoin: () => void;
}) {
  const recent = showKnown ? otherWorkspaces(known) : [];
  return (
    <>
      <h1>{title}</h1>
      <p className="muted">Your pages are Markdown files in a workspace, with their whole history.</p>
      <Choices>
        <Choice
          icon={<Plus size={18} />}
          title="Start a new workspace"
          text="Name it, and choose where it's kept."
          onClick={onNew}
        />
        <Choice
          icon={<LogIn size={18} />}
          title="Join a workspace"
          text="One you already use on another device."
          onClick={onJoin}
        />
      </Choices>

      {recent.length > 0 && (
        <section className="card">
          <h2>Recent workspaces</h2>
          <ul className="recent">
            {recent.map((entry) => (
              <li key={entry.path} className={"recent-row" + (entry.missing ? " missing" : "")}>
                <button
                  className="recent-open"
                  disabled={busy}
                  title={entry.missing ? `Not found at ${entry.path}` : entry.path}
                  onClick={() =>
                    void run(async () => {
                      if (!entry.missing) return api.openWorkspace(entry.path);
                      const path = await pickFolder(`Where is “${entry.name}” now?`);
                      return path ? api.locateWorkspace(entry.path, path) : null;
                    })
                  }
                >
                  <span className="recent-name">{entry.name}</span>
                  <span className="recent-path muted small">
                    {entry.missing ? "Not found: click to locate it" : entry.path}
                  </span>
                </button>
                {entry.missing && (
                  <>
                    <FolderSearch size={14} className="muted" aria-hidden />
                    <button
                      className="icon-button"
                      title="Remove from this list (doesn't delete anything)"
                      aria-label={`Remove “${entry.name}” from the list`}
                      onClick={() => void api.forgetWorkspace(entry.path).then(loadKnown)}
                    >
                      <X size={14} />
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="muted small wizard-foot">
        Have a workspace folder already?{" "}
        <button
          type="button"
          className="link"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const path = await pickFolder("Open a workspace");
              return path ? api.openWorkspace(path) : null;
            })
          }
        >
          Open it…
        </button>
      </p>
    </>
  );
}

/**
 * "Kept in  On this computer  Change…": where a workspace is kept, as a
 * folder. `folder` null is this computer only.
 */
function KeptIn({
  name,
  folder,
  setFolder,
  folders,
  busy,
  setError,
}: {
  name: string;
  folder: string | null;
  setFolder: (folder: string | null) => void;
  folders: CloudFolder[];
  busy: boolean;
  setError: (e: string | null) => void;
}) {
  const [place, setPlace] = useState<FolderPlace | null>(null);
  useEffect(() => {
    setPlace(null);
    if (!folder) return;
    void api.folderPlace(folder).then(setPlace, (e) => setError(errorText(e)));
  }, [folder, setError]);

  const choose = async (start?: string) => {
    const picked = await pickFolder(`Where should “${name}” be kept?`, start);
    if (picked) {
      setError(null);
      setFolder(picked);
    }
  };

  return (
    <div className="kept-in">
      <div className="kept-in-row">
        <span className="muted">Kept in</span>
        <span className="kept-in-place" title={folder ?? undefined}>
          {folder ? (place?.label ?? "…") : "On this computer"}
        </span>
        <button type="button" className="button" disabled={busy} onClick={() => void choose()}>
          Change…
        </button>
      </div>
      {folder ? (
        <p className="kept-in-note muted small">
          Pagemesh adds a “{name}.docsync” folder there.{" "}
          {place && !place.cloud && "That only reaches devices that can open this folder too, like a network drive. "}
          <button type="button" className="link" disabled={busy} onClick={() => setFolder(null)}>
            Keep it on this computer instead
          </button>
        </p>
      ) : (
        <p className="kept-in-note tip small">
          Tip: to have it on all your devices, choose a folder in{" "}
          {folders.length > 0
            ? folders.map((f, i) => (
                <span key={f.path}>
                  {i > 0 && (i === folders.length - 1 ? " or " : ", ")}
                  <button type="button" className="link" disabled={busy} onClick={() => void choose(f.path)}>
                    {f.name}
                  </button>
                </span>
              ))
            : "Dropbox, OneDrive or iCloud Drive"}
          .
        </p>
      )}
    </div>
  );
}

/**
 * The two places a workspace can be kept, as blocks that are always both
 * visible. The chosen one opens to show what to do there.
 */
function Places({
  kind,
  setKind,
  folderText,
  folder,
  git,
}: {
  kind: Kind;
  setKind: (kind: Kind) => void;
  folderText: string;
  folder: ReactNode;
  git: ReactNode;
}) {
  const block = (k: Kind, icon: ReactNode, title: string, text: string, body: ReactNode) => (
    <section className={"place-option" + (kind === k ? " selected" : "")}>
      <button
        type="button"
        className="place-head"
        role="radio"
        aria-checked={kind === k}
        onClick={() => setKind(k)}
      >
        <span className="radio" aria-hidden />
        <span className="choice-icon" aria-hidden>
          {icon}
        </span>
        <span className="choice-text">
          <span className="choice-title">{title}</span>
          <span className="muted small">{text}</span>
        </span>
      </button>
      {kind === k && <div className="place-body">{body}</div>}
    </section>
  );
  return (
    <div className="places" role="radiogroup" aria-label="Where it's kept">
      {block("folder", <FolderSync size={18} />, "In a folder", folderText, folder)}
      {block("git", <GitBranch size={18} />, "In a Git repository", "On GitHub, or any other Git server.", git)}
    </div>
  );
}

/** A new workspace: its name and where it's kept, on one screen. */
function NewStep(props: StepProps & { rawName: string; setName: (name: string) => void }) {
  const { name, rawName, setName, folders, busy, run, setError } = props;
  const [kind, setKind] = useState<Kind>("folder");
  const [folder, setFolder] = useState<string | null>(null);
  return (
    <>
      <h1>Start a new workspace</h1>
      <label className="kept-in-row name-row">
        <span className="muted">Name</span>
        <input
          className="input"
          aria-label="Workspace name"
          value={rawName}
          autoFocus
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <h2 className="places-title">Where should it be kept?</h2>
      <Places
        kind={kind}
        setKind={setKind}
        folderText="On this computer, or in a folder you choose."
        folder={
          <form
            className="kept-in-form"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => (folder ? api.createFolderWorkspace(name, folder) : api.createWorkspace(name)));
            }}
          >
            <KeptIn name={name} folder={folder} setFolder={setFolder} folders={folders} busy={busy} setError={setError} />
            <div className="row end">
              <button className="button primary" disabled={busy || !rawName.trim()}>
                Create
              </button>
            </div>
          </form>
        }
        git={<GitOptions {...props} intent="new" />}
      />
    </>
  );
}

/** Joining a workspace from another device: from its folder or its repository. */
function JoinStep(props: StepProps) {
  const [kind, setKind] = useState<Kind>("folder");
  return (
    <>
      <h1>Join a workspace</h1>
      <p className="muted">
        One you already use on another device. Its pages are copied to this computer, and it keeps syncing with the
        place it's kept.
      </p>
      <Places
        kind={kind}
        setKind={setKind}
        folderText={`Its “.docsync” folder, for example in ${cloudNames(props.folders.map((f) => f.name)) || "Dropbox, OneDrive or iCloud Drive"}.`}
        folder={<JoinFolder {...props} />}
        git={<GitOptions {...props} intent="join" />}
      />
    </>
  );
}

/** Changing where the open workspace is kept. */
function ChangeStep(props: StepProps & { workspace: WorkspaceInfo }) {
  const { name, folders, busy, run, setError, workspace } = props;
  const current = isFolderRemote(workspace.remote) ? folderOfRemote(workspace.remote!) : null;
  const [kind, setKind] = useState<Kind>(workspace.remote && !current ? "git" : "folder");
  const [folder, setFolder] = useState<string | null>(current);
  const unchanged = folder === current && (folder !== null || !workspace.remote);
  const save = () =>
    run(async () => {
      if (folder) return api.syncThroughFolder(folder);
      const sure = await ask(
        `Changes on this computer won't reach your other devices anymore. What's in ${workspace.keptIn ?? "the old place"} stays there.`,
        { title: `Keep “${name}” only on this computer?`, kind: "warning", okLabel: "Keep it here only" },
      );
      return sure ? api.setRemote(null) : null;
    });
  return (
    <>
      <h1>Where should “{name}” be kept?</h1>
      <p className="muted">
        {workspace.keptIn
          ? `It's kept in ${workspace.keptIn} now. The whole history goes along to the new place. Your other devices keep using ${workspace.keptIn} until you change it there too.`
          : "It's only on this computer now. The whole history goes along to the new place."}
      </p>
      <Places
        kind={kind}
        setKind={setKind}
        folderText="On this computer, or in a folder you choose."
        folder={
          <>
            <KeptIn name={name} folder={folder} setFolder={setFolder} folders={folders} busy={busy} setError={setError} />
            <div className="row end">
              <button className="button primary" disabled={busy || unchanged} onClick={() => void save()}>
                Save
              </button>
            </div>
          </>
        }
        git={<GitOptions {...props} intent="change" />}
      />
    </>
  );
}

/** Joining a workspace kept in a folder: its `.docsync` folder. */
function JoinFolder({ known, cloud, folders, busy, run, setError }: StepProps) {
  const [picked, setPicked] = useState<FoundWorkspace[] | null>(null);
  const choose = async (start?: string) => {
    const path = await pickFolder("Choose the workspace's “.docsync” folder", start);
    if (!path) return;
    setError(null);
    try {
      const found = await api.workspacesInFolder(path);
      if (found.length === 1) await run(() => api.joinWorkspace(found[0]!.path));
      else if (found.length === 0) setError("There's no workspace there: look for a folder ending in “.docsync”.");
      else setPicked(found);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const found = picked ?? joinableInCloud(cloud?.workspaces ?? [], known);
  return (
    <>
      {cloud === null ? (
        <p className="muted small">Looking in your cloud folders…</p>
      ) : (
        found.length > 0 && (
          <>
            <h3>{picked ? "Workspaces in that folder" : "Found in your cloud folders"}</h3>
            <ul className="recent">
              {found.map((w) => (
                <li key={w.path} className="recent-row">
                  <button
                    className="recent-open"
                    disabled={busy}
                    title={`Join ${w.path} on this device`}
                    onClick={() => void run(() => api.joinWorkspace(w.path))}
                  >
                    <span className="recent-name">{w.name}</span>
                    <span className="recent-path muted small">In {w.cloud}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )
      )}
      <div className="row">
        <button className="button" disabled={busy} onClick={() => void choose()}>
          Choose folder…
        </button>
      </div>
      {folders.length > 0 && (
        <p className="muted small">
          Or look in{" "}
          {folders.map((f, i) => (
            <span key={f.path}>
              {i > 0 && (i === folders.length - 1 ? " or " : ", ")}
              <button type="button" className="link" disabled={busy} onClick={() => void choose(f.path)}>
                {f.name}
              </button>
            </span>
          ))}
        </p>
      )}
    </>
  );
}

/** A Git repository: GitHub, or any Git URL. */
function GitOptions(props: StepProps & { intent: Intent }) {
  return (
    <>
      <h3>GitHub</h3>
      <GitHubPanel {...props} />
      <hr className="divider" />
      <h3>Another Git server</h3>
      <UrlForm {...props} />
    </>
  );
}

/**
 * GitHub: sign in, install the app if needed, then create a private repo
 * (new, change) or pick a workspace that's there (join).
 */
function GitHubPanel({ name, known, busy, run, intent }: StepProps & { intent: Intent }) {
  const [user, setUser] = useGitHubAccount();
  const [signingIn, setSigningIn] = useState(false);
  const [remote, setRemote] = useState<RemoteWorkspace[] | null>(null);
  const [access, setAccess] = useState<GitHubAccess | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    setRemote(null);
    setAccess(null);
    setProblem(null);
    if (!user) return;
    const load = () => {
      void api.githubAccess().then(setAccess, () => setAccess(null));
      if (intent === "join")
        void api.githubWorkspaces().then(setRemote, (e) => {
          setRemote([]);
          setProblem(errorText(e));
        });
    };
    load();
    // Back from installing the app or changing its repositories on GitHub.
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [user, intent]);

  if (user === undefined) return <p className="muted">Checking your GitHub account…</p>;

  if (!user) {
    return (
      <>
        <p className="muted">
          {intent === "join"
            ? "Sign in to see your workspaces on GitHub."
            : `A private repository on your GitHub account. Pagemesh only gets the repositories you choose.`}
        </p>
        <div className="row">
          <button className="button primary" disabled={busy} onClick={() => setSigningIn(true)}>
            Continue with GitHub
          </button>
        </div>
        {signingIn && (
          <GitHubSignIn
            onDone={(u: GitHubUser) => {
              setSigningIn(false);
              setUser(u);
            }}
            onClose={() => {
              setSigningIn(false);
              // Cancelling while installing still leaves them signed in.
              void api.githubAccount().then(setUser, () => undefined);
            }}
          />
        )}
      </>
    );
  }

  const account = (
    <div className="github-account">
      <img className="avatar" src={user.avatarUrl} alt="" width={20} height={20} />
      <span className="github-name">
        {user.name?.trim() || user.login} <span className="muted">@{user.login}</span>
      </span>
      <button type="button" className="link" onClick={() => void api.githubSignOut().then(() => setUser(null))}>
        Sign out
      </button>
    </div>
  );

  if (access && !access.installed) {
    return (
      <>
        {account}
        <p className="muted">
          Next, install Pagemesh on your GitHub account and choose which repositories it may use. Come back here when
          you're done.
        </p>
        <div className="row">
          <button className="button primary" onClick={() => void openUrl(access.manageUrl)}>
            Install on GitHub…
          </button>
        </div>
      </>
    );
  }

  const chooseRepos = access && !access.allRepositories && (
    <p className="muted small">
      Don't see a workspace? Pagemesh only sees the repositories you chose.{" "}
      <button type="button" className="link" onClick={() => void openUrl(access.manageUrl)}>
        Choose repositories…
      </button>
    </p>
  );

  if (intent === "join") {
    const toJoin = remote && joinable(remote, known);
    return (
      <>
        {account}
        {toJoin === null ? (
          <p className="muted">Looking for your workspaces on GitHub…</p>
        ) : toJoin.length === 0 ? (
          <p className="muted">No workspaces on GitHub that aren't on this computer already.</p>
        ) : (
          <ul className="recent">
            {toJoin.map((w) => (
              <li key={w.fullName} className="recent-row">
                <button
                  className="recent-open"
                  disabled={busy}
                  title={`Join ${w.fullName} on this device`}
                  onClick={() => void run(() => api.joinWorkspace(w.cloneUrl))}
                >
                  <span className="recent-name">{w.name}</span>
                  <span className="recent-path muted small">{w.fullName}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {chooseRepos}
        {problem && <p className="error small">{problem}</p>}
      </>
    );
  }

  const create = () =>
    run(async () => {
      if (intent === "new") {
        const created = await api.createGitHubWorkspace(name);
        if (created.problem) {
          await message(`“${created.workspace.name}” is only on this computer for now: ${created.problem}`, {
            title: "Couldn't create the GitHub repository",
            kind: "warning",
          });
        } else if (!created.reachable && created.manageUrl) {
          await oneMoreStep(created.fullName ?? name, created.manageUrl);
        }
        return created.workspace;
      }
      const created = await api.githubCreateRepo();
      if (!created.reachable) await oneMoreStep(created.fullName, created.manageUrl);
      return created.workspace;
    });

  return (
    <>
      {account}
      <p className="muted">A new private repository called “{name}” on your account.</p>
      <div className="row">
        <button className="button primary" disabled={busy} onClick={() => void create()}>
          {intent === "new" ? "Create on GitHub" : "Move to GitHub"}
        </button>
      </div>
    </>
  );
}

async function oneMoreStep(fullName: string, manageUrl: string) {
  await message(
    `Created ${fullName}. Pagemesh can only reach the repositories you chose: add this one on GitHub and it starts syncing.`,
    { title: "One more step on GitHub", kind: "info" },
  );
  await openUrl(manageUrl);
}

/** Any Git URL: an empty repository for a new workspace, or one to join. */
function UrlForm({ name, busy, run, intent }: StepProps & { intent: Intent }) {
  const [url, setUrl] = useState("");
  const submit = () =>
    run(async () => {
      const target = url.trim();
      if (intent === "join") return api.joinWorkspace(target);
      if (intent === "change") return api.setRemote(target);
      const workspace = await api.createWorkspace(name);
      try {
        return await api.setRemote(target);
      } catch (e) {
        await message(`“${workspace.name}” is only on this computer for now: ${errorText(e)}`, {
          title: "Couldn't use that repository",
          kind: "warning",
        });
        return workspace;
      }
    });
  return (
    <>
      <p className="muted">
        {intent === "join" ? "The repository's URL" : "The URL of an empty repository"}, HTTPS or SSH, on GitLab or
        any other Git server.
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <input
          className="input"
          aria-label="Git URL"
          placeholder="https://gitlab.com/you/notes.git"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          spellCheck={false}
        />
        <button className="button" disabled={busy || !url.trim()}>
          {intent === "join" ? "Join" : intent === "new" ? "Create" : "Move here"}
        </button>
      </form>
    </>
  );
}
