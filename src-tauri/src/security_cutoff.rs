//! Production security cutoffs for 401 / logout / session transition.
//!
//! **Honest non-claims:** no real SSH sessions exist yet. Vault core (8A1)
//! is a separate module — this cutoff is still a fail-closed gate, not the
//! real Stronghold vault lock.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

/// Process-wide fail-closed gates: SSH generation + vault lock.
///
/// Vault starts **locked**. Only an explicit Task 8 unlock path may unlock.
#[derive(Debug)]
pub struct SecurityCutoff {
    /// Incremented on every SSH cutoff (401 / logout / successful re-login transition).
    ssh_generation: AtomicU64,
    /// Sticky lock; starts true (fail-closed at process start).
    vault_locked: AtomicBool,
}

impl SecurityCutoff {
    /// Fail-closed: vault locked until Task 8 unlocks.
    pub fn new() -> Self {
        Self {
            ssh_generation: AtomicU64::new(0),
            vault_locked: AtomicBool::new(true),
        }
    }

    /// Advance SSH cutoff generation. Returns the new generation.
    pub fn close_all_ssh(&self) -> u64 {
        self.ssh_generation.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn ssh_generation(&self) -> u64 {
        self.ssh_generation.load(Ordering::SeqCst)
    }

    pub fn ssh_session_still_valid(&self, captured_gen: u64) -> bool {
        self.ssh_generation() == captured_gen
    }

    pub fn lock_vault(&self) {
        self.vault_locked.store(true, Ordering::SeqCst);
    }

    pub fn is_vault_locked(&self) -> bool {
        self.vault_locked.load(Ordering::SeqCst)
    }

    /// Explicit Task 8 unlock only (called after real VaultService unlock succeeds).
    pub(crate) fn unlock_vault_for_task8(&self) {
        self.vault_locked.store(false, Ordering::SeqCst);
    }

    #[cfg(test)]
    pub fn unlock_vault_for_tests(&self) {
        self.unlock_vault_for_task8();
    }
}

impl Default for SecurityCutoff {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_starts_locked_new_and_default() {
        assert!(SecurityCutoff::new().is_vault_locked());
        assert!(SecurityCutoff::default().is_vault_locked());
    }

    #[test]
    fn ssh_cutoff_increments_and_invalidates_old_capture() {
        let c = SecurityCutoff::new();
        assert_eq!(c.ssh_generation(), 0);
        let g0 = c.ssh_generation();
        assert!(c.ssh_session_still_valid(g0));
        let g1 = c.close_all_ssh();
        assert_eq!(g1, 1);
        assert!(!c.ssh_session_still_valid(g0));
        assert!(c.ssh_session_still_valid(g1));
    }

    #[test]
    fn vault_lock_sticky_only_task8_unlocks() {
        let c = SecurityCutoff::new();
        assert!(c.is_vault_locked());
        c.lock_vault();
        assert!(c.is_vault_locked());
        c.unlock_vault_for_task8();
        assert!(!c.is_vault_locked());
        c.lock_vault();
        assert!(c.is_vault_locked());
    }
}
