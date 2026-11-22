import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Copy, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type DeviceCode, type GitHubUser, api, errorText, events } from "./api.ts";

/** Tells sign-in attempts apart, e.g. when React runs an effect twice. */
let attempts = 0;

/** The signed-in GitHub account, kept up to date. */
export function useGitHubAccount(): [GitHubUser | null | undefined, (user: GitHubUser | null) => void] {
  // undefined while the keychain is being read.
  const [user, setUser] = useState<GitHubUser | null | undefined>(undefined);
  useEffect(() => {
    const load = () =>
      void api
        .githubAccount()
        .then(setUser)
        .catch(() => setUser(null));
    load();
    const unlisten = events.onAccountChanged(load);
    return () => void unlisten.then((f) => f());
  }, []);
  return [user, setUser];
}

/**
 * Signing in with GitHub's device flow: show a code, open
 * github.com/login/device, and wait there for the user to approve it.
 */
export function GitHubSignIn({ onDone, onClose }: { onDone: (user: GitHubUser) => void; onClose: () => void }) {
  const [code, setCode] = useState<DeviceCode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [retries, setRetries] = useState(0);
  const current = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    const attempt = ++attempts;
    current.current = attempt;
    const live = () => current.current === attempt;
    setCode(null);
    setError(null);
    void (async () => {
      try {
        const next = await api.githubSignInStart(attempt);
        if (!live()) return;
        setCode(next);
        const user = await api.githubSignInFinish(attempt);
        if (live() && user) done.current(user);
      } catch (e) {
        if (live()) setError(errorText(e));
      }
    })();
    return () => {
      if (live()) current.current = 0;
      // Stops the wait on the Rust side.
      void api.githubSignInCancel(attempt);
    };
  }, [retries]);

  const cancel = () => {
    void api.githubSignInCancel(current.current);
    onClose();
  };

  const openGitHub = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.userCode);
      setCopied(true);
    } catch {
      // The code is on screen to type in.
    }
    await openUrl(code.verificationUri);
  };

  return createPortal(
    <div className="overlay" onMouseDown={cancel}>
      <div
        className="dialog sign-in"
        role="dialog"
        aria-label="Sign in with GitHub"
        tabIndex={-1}
        ref={(el) => el?.focus()}
        onKeyDown={(e) => e.key === "Escape" && cancel()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2>Sign in with GitHub</h2>
        {error ? (
          <>
            <p className="error" role="alert">
              {error}
            </p>
            <div className="row end">
              <button className="button" onClick={cancel}>
                Cancel
              </button>
              <button className="button primary" onClick={() => setRetries(retries + 1)}>
                Try again
              </button>
            </div>
          </>
        ) : !code ? (
          <p className="muted">Asking GitHub for a code…</p>
        ) : (
          <>
            <p>Enter this code on GitHub to let Pagemesh sync your workspaces:</p>
            <div className="sign-in-code">
              <code aria-label="Sign-in code">{code.userCode}</code>
              <button
                className="icon-button"
                title="Copy the code"
                aria-label="Copy the code"
                onClick={() => void navigator.clipboard.writeText(code.userCode).then(() => setCopied(true))}
              >
                <Copy size={15} />
              </button>
            </div>
            <div className="row end">
              <button className="button" onClick={cancel}>
                Cancel
              </button>
              <button className="button primary" autoFocus onClick={() => void openGitHub()}>
                {copied ? "Open GitHub" : "Copy code and open GitHub"} <ExternalLink size={13} aria-hidden />
              </button>
            </div>
            <p className="muted small">
              Waiting for you to approve it… Pagemesh can only reach the repositories you choose when you install it,
              and your notes go straight from this device to GitHub.
            </p>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
