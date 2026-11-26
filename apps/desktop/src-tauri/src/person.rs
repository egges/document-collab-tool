//! Who is using this device: the person new commits are by, and whom
//! conflict blocks call "You".
//!
//! A person has a name and an id. The name is a setting (Settings ›
//! Account), filled in from the GitHub account or from Git's own `user.name`
//! until the user changes it. The id is ours, never a Git host's, so any
//! host works:
//!
//! - Signed in (to GitHub, for now), we know who you are: the id comes from
//!   the account's no-reply address, in every workspace, whether it's kept
//!   in a Git repository or synced through a cloud folder.
//! - Otherwise, in a workspace kept in a Git repository (any URL), it comes
//!   from Git's own `user.email`, the email commits are by there.
//! - Otherwise, as for a workspace synced through a cloud folder such as
//!   Dropbox, persons aren't linked: the id is this app install's own, made
//!   once and kept in `settings.json`, and commits get a placeholder email
//!   (`<id>@people.invalid`) rather than a real one.
//!
//! Where the id comes from an email, the same email on two devices gives
//! the same id, so both count as "You".
//!
//! docsync records the id in every commit (a `Person-Id` trailer) and reads
//! it back when it labels a conflict block.

use std::path::Path;
use std::sync::Mutex;

use docsync::Person;
use sha2::{Digest, Sha256};

use crate::github::GitHubUser;

/// The longest name a person or device can be given.
pub const MAX_NAME: usize = 60;

/// What's known about the person on this device.
#[derive(Debug, Default, Clone)]
pub struct Identity {
    /// The name chosen in Settings, if it differs from the one filled in.
    pub name: Option<String>,
    /// This install's own person id, for workspaces where persons aren't linked.
    pub local_id: Option<String>,
    /// Git's global `user.name` and `user.email`, if set.
    pub git_name: Option<String>,
    pub git_email: Option<String>,
}

static IDENTITY: Mutex<Identity> = Mutex::new(Identity {
    name: None,
    local_id: None,
    git_name: None,
    git_email: None,
});

/// A name as one line with single spaces, without control characters, at
/// most [`MAX_NAME`] characters: it's shown in labels and recorded in commits.
pub fn clean_name(name: &str) -> String {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let name: String = name.chars().filter(|c| !c.is_control()).take(MAX_NAME).collect();
    name.trim().to_string()
}

/// A new random person id: 16 hex digits.
pub fn new_local_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("random bytes");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// At startup: the name chosen in Settings and this install's person id.
pub fn load(name: Option<String>, local_id: String) {
    let mut identity = IDENTITY.lock().unwrap();
    identity.name = name;
    identity.local_id = Some(local_id);
}

/// At startup: Git's global `user.name` and `user.email`, which fill in the
/// person when nobody signed in with GitHub. The app's own Git commands
/// ignore the global configuration; this only reads it.
pub fn load_git_identity(git: &Path) {
    let read = |key: &str| {
        std::process::Command::new(git)
            .args(["config", "--global", "--get", key])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let (name, email) = (read("user.name"), read("user.email"));
    let mut identity = IDENTITY.lock().unwrap();
    identity.git_name = name.map(|n| clean_name(&n)).filter(|n| !n.is_empty());
    identity.git_email = email.filter(|e| e.contains('@'));
}

/// Call the person `name` from now on; empty (or the name that would be
/// filled in anyway) goes back to filling it in. Returns what to keep in
/// the settings. An open workspace needs `Session::refresh_person`.
pub fn set_name(name: &str, user: Option<&GitHubUser>) -> Option<String> {
    let mut identity = IDENTITY.lock().unwrap();
    let name =
        Some(clean_name(name)).filter(|n| !n.is_empty() && Some(n) != default_name(&identity, user).as_ref());
    identity.name = name.clone();
    name
}

/// Whether persons are linked across devices for a workspace synced with
/// `remote`: only through a Git repository, never through a cloud folder.
pub fn linked(remote: Option<&str>) -> bool {
    remote.is_some_and(|url| !crate::cloud::is_folder_remote(url))
}

/// Who new commits are by on this device, for a workspace whose persons are
/// `linked` or not; `None` when there's no name yet (commits are then by
/// the device).
pub fn person(user: Option<&GitHubUser>, linked: bool) -> Option<Person> {
    person_from(&IDENTITY.lock().unwrap(), user, linked)
}

/// The name filled in when none was chosen.
fn default_name(identity: &Identity, user: Option<&GitHubUser>) -> Option<String> {
    user.map(|u| clean_name(u.display_name()))
        .filter(|n| !n.is_empty())
        .or_else(|| identity.git_name.clone())
}

pub fn person_from(identity: &Identity, user: Option<&GitHubUser>, linked: bool) -> Option<Person> {
    let name = identity.name.clone().or_else(|| default_name(identity, user))?;
    // Signed in: always that account. Otherwise Git's email, where it's the one commits go by.
    let email = user
        .map(GitHubUser::noreply_email)
        .or_else(|| identity.git_email.clone().filter(|_| linked));
    if let Some(email) = email {
        return Some(Person {
            name,
            id: Some(email_id(&email)),
            email,
        });
    }
    let id = identity.local_id.clone().unwrap_or_else(|| "unsaved".into());
    Some(Person {
        name,
        email: format!("{id}@people.invalid"),
        id: Some(id),
    })
}

/// The person id for an email: the same on every device, without putting
/// the email itself in pages.
fn email_id(email: &str) -> String {
    let hash = Sha256::digest(email.trim().to_lowercase().as_bytes());
    hash[..8].iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn github(name: Option<&str>) -> GitHubUser {
        GitHubUser {
            id: 7,
            login: "ada".into(),
            name: name.map(String::from),
            avatar_url: String::new(),
        }
    }

    fn identity(name: Option<&str>, git: Option<(&str, &str)>) -> Identity {
        Identity {
            name: name.map(String::from),
            local_id: Some("1111222233334444".into()),
            git_name: git.map(|(n, _)| n.to_string()),
            git_email: git.map(|(_, e)| e.to_string()),
        }
    }

    #[test]
    fn in_a_git_repository_the_id_follows_the_email_across_devices() {
        let laptop = identity(None, Some(("Ada", "ada@example.com")));
        let desktop = Identity {
            local_id: Some("5555666677778888".into()),
            git_email: Some(" Ada@Example.com".into()),
            ..laptop.clone()
        };
        let a = person_from(&laptop, None, true).unwrap();
        let b = person_from(&desktop, None, true).unwrap();
        assert_eq!(a.name, "Ada");
        assert_eq!(a.email, "ada@example.com");
        assert_eq!(a.id, b.id, "same email, same person");
        assert_eq!(a.id.as_deref().map(str::len), Some(16));
        assert!(!a.id.as_deref().unwrap().contains("ada"));

        // GitHub's account comes first, by its no-reply address.
        let signed_in = person_from(&laptop, Some(&github(Some("Ada Lovelace"))), true).unwrap();
        assert_eq!(signed_in.name, "Ada Lovelace");
        assert_eq!(signed_in.email, "7+ada@users.noreply.github.com");
        assert_ne!(signed_in.id, a.id);
        // Two people with the same name are still two people.
        let other = identity(None, Some(("Ada", "other.ada@example.com")));
        assert_ne!(person_from(&other, None, true).unwrap().id, a.id);
    }

    #[test]
    fn signed_in_the_account_is_used_in_every_workspace() {
        let id = identity(None, Some(("Ada", "ada@example.com")));
        let user = github(Some("Ada Lovelace"));
        let in_git = person_from(&id, Some(&user), true).unwrap();
        let in_dropbox = person_from(&id, Some(&user), false).unwrap();
        assert_eq!(in_dropbox, in_git);
        assert_eq!(in_dropbox.email, "7+ada@users.noreply.github.com");
        // And on another device, signed in to the same account.
        let other_device = Identity {
            local_id: Some("5555666677778888".into()),
            git_email: None,
            ..id
        };
        assert_eq!(
            person_from(&other_device, Some(&user), false).unwrap().id,
            in_git.id
        );
    }

    #[test]
    fn signed_out_through_a_cloud_folder_persons_are_not_linked() {
        let id = identity(None, Some(("Ada", "ada@example.com")));
        let person = person_from(&id, None, false).unwrap();
        assert_eq!(person.id.as_deref(), Some("1111222233334444"));
        // No real email in a folder anyone with the folder can read.
        assert_eq!(person.email, "1111222233334444@people.invalid");
        // A Git repository without any email to go by isn't linked either.
        let no_email = identity(Some("Ada"), None);
        assert_eq!(
            person_from(&no_email, None, true).unwrap().id.as_deref(),
            Some("1111222233334444")
        );
    }

    #[test]
    fn the_name_is_filled_in_until_it_is_chosen() {
        assert_eq!(person_from(&identity(None, None), None, true), None);
        let git = Some(("Ada L.", "ada@example.com"));
        assert_eq!(
            person_from(&identity(None, git), None, true).unwrap().name,
            "Ada L."
        );
        assert_eq!(
            person_from(&identity(None, git), Some(&github(None)), true)
                .unwrap()
                .name,
            "ada",
            "GitHub's login when the account has no name"
        );
        let chosen = person_from(&identity(Some("Ada"), git), Some(&github(Some("A. L."))), true).unwrap();
        assert_eq!(chosen.name, "Ada");
        assert_eq!(clean_name("  Ada \n  Lovelace "), "Ada Lovelace");
    }
}
