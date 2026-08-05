//! Linux logind sleep/lock observers via zbus (Task 4).
//!
//! - `PrepareForSleep` on Manager
//! - Session path via **`GetSessionByPID`** (current process)
//! - Session `Lock` / `Unlock` signals
//! - Cancel via `watch` + **`tokio::select!`** covering **setup and** run (not sleep-poll only)
//! - Startup **Result handshake** before `Registration` is returned
//! - After handshake: stream/bus end without cancel → **mark unhealthy + `on_system_sleep`**
//! - Explicit cancel must **not** mark unhealthy
//! - Drop: signal cancel, **direct** `join` (no detached helper join thread)
//! - Stream polling via `zbus::export::futures_core::Stream` + `std::future::poll_fn`
//!   (no direct futures-core / futures-util dependency)

use super::ObserverHealth;
use crate::vault_lifecycle_coordinator::VaultLifecycleCoordinator;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::sync::watch;

pub struct Registration {
    cancel_tx: watch::Sender<bool>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl Registration {
    /// Start worker; `Ok` only after subscriptions are established.
    pub fn try_new(
        coordinator: Arc<VaultLifecycleCoordinator>,
        health: Arc<ObserverHealth>,
    ) -> Result<Self, ()> {
        let (cancel_tx, cancel_rx) = watch::channel(false);
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<Result<(), ()>>(1);

        let join = std::thread::Builder::new()
            .name("opsmate-vault-os-sleep-linux".into())
            .spawn(move || {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(_) => {
                        let _ = ready_tx.send(Err(()));
                        return;
                    }
                };
                rt.block_on(async move {
                    if setup_and_run(coordinator, health, cancel_rx, &ready_tx)
                        .await
                        .is_err()
                    {
                        let _ = ready_tx.send(Err(()));
                    }
                });
            })
            .map_err(|_| ())?;

        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => Ok(Self {
                cancel_tx,
                join: Mutex::new(Some(join)),
            }),
            Ok(Err(())) | Err(_) => {
                // Cancel must cover setup futures so join cannot hang before select.
                // Setup failure does not mark unhealthy (Registration never returned).
                let _ = cancel_tx.send(true);
                let _ = join.join();
                Err(())
            }
        }
    }
}

impl Drop for Registration {
    fn drop(&mut self) {
        let _ = self.cancel_tx.send(true);
        if let Ok(mut g) = self.join.lock() {
            if let Some(h) = g.take() {
                // Direct join only — no detached helper thread.
                let _ = h.join();
            }
        }
    }
}

/// Unexpected listener death: mark unhealthy under latch mutex, then seal after release.
fn seal_take_unhealthy(
    health: &ObserverHealth,
    coord: &Mutex<Option<Arc<VaultLifecycleCoordinator>>>,
) {
    health.mark_unhealthy_then(|| {
        if let Ok(mut g) = coord.lock() {
            if let Some(c) = g.take() {
                let _ = c.on_system_sleep();
            }
        }
    });
}

fn drop_coord(coord: &Mutex<Option<Arc<VaultLifecycleCoordinator>>>) {
    if let Ok(mut g) = coord.lock() {
        *g = None;
    }
}

async fn setup_and_run(
    coordinator: Arc<VaultLifecycleCoordinator>,
    health: Arc<ObserverHealth>,
    mut cancel_rx: watch::Receiver<bool>,
    ready_tx: &std::sync::mpsc::SyncSender<Result<(), ()>>,
) -> Result<(), ()> {
    use zbus::zvariant::OwnedObjectPath;
    use zbus::{Message, Proxy};

    // Outer cancellation covers setup: ready-timeout cancel must not hang on dbus awaits.
    if *cancel_rx.borrow() {
        return Err(());
    }

    let setup = async {
        let conn = zbus::Connection::system().await.map_err(|_| ())?;

        let manager = Proxy::new(
            &conn,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .await
        .map_err(|_| ())?;

        // Session Lock/Unlock: GetSessionByPID(current pid) — required, not GetSession("auto").
        let pid: u32 = std::process::id();
        let session_path: OwnedObjectPath = manager
            .call("GetSessionByPID", &(pid,))
            .await
            .map_err(|_| ())?;

        let session = Proxy::new(
            &conn,
            "org.freedesktop.login1",
            session_path.as_str(),
            "org.freedesktop.login1.Session",
        )
        .await
        .map_err(|_| ())?;

        let sleep_stream = manager
            .receive_signal("PrepareForSleep")
            .await
            .map_err(|_| ())?;
        let lock_stream = session.receive_signal("Lock").await.map_err(|_| ())?;
        let unlock_stream = session.receive_signal("Unlock").await.map_err(|_| ())?;
        Ok::<_, ()>((sleep_stream, lock_stream, unlock_stream))
    };

    let (mut sleep_stream, mut lock_stream, mut unlock_stream) = tokio::select! {
        biased;
        changed = cancel_rx.changed() => {
            let _ = changed;
            return Err(());
        }
        r = setup => r?,
    };

    if *cancel_rx.borrow() {
        return Err(());
    }

    // Startup handshake: subscriptions established.
    ready_tx.send(Ok(())).map_err(|_| ())?;

    let coord = Mutex::new(Some(coordinator));

    loop {
        if *cancel_rx.borrow() {
            break;
        }
        tokio::select! {
            biased;
            // Cancellation-select (primary cancel path).
            changed = cancel_rx.changed() => {
                let _ = changed;
                break;
            }
            next = signal_next(&mut sleep_stream) => {
                if *cancel_rx.borrow() { break; }
                let Some(msg) = next else {
                    // Stream/bus ended without cancel — mark unhealthy then seal.
                    seal_take_unhealthy(&health, &coord);
                    return Ok(());
                };
                let msg: Message = msg;
                if let Ok(sleeping) = msg.body().deserialize::<bool>() {
                    if let Ok(g) = coord.lock() {
                        if let Some(c) = g.as_ref() {
                            if sleeping {
                                let _ = c.on_system_sleep();
                            } else {
                                let _ = c.on_resume();
                            }
                        }
                    }
                }
            }
            next = signal_next(&mut lock_stream) => {
                if *cancel_rx.borrow() { break; }
                let Some(_) = next else {
                    seal_take_unhealthy(&health, &coord);
                    return Ok(());
                };
                if let Ok(g) = coord.lock() {
                    if let Some(c) = g.as_ref() {
                        let _ = c.on_system_sleep();
                    }
                }
            }
            next = signal_next(&mut unlock_stream) => {
                if *cancel_rx.borrow() { break; }
                let Some(_) = next else {
                    seal_take_unhealthy(&health, &coord);
                    return Ok(());
                };
                if let Ok(g) = coord.lock() {
                    if let Some(c) = g.as_ref() {
                        let _ = c.on_resume();
                    }
                }
            }
        }
    }

    // Explicit cancel: drop coord without sealing and without mark_unhealthy.
    drop_coord(&coord);
    Ok(())
}

/// Next item from a zbus signal stream without `futures-util::StreamExt`.
async fn signal_next<S>(stream: &mut S) -> Option<S::Item>
where
    S: zbus::export::futures_core::Stream + Unpin,
{
    use std::future::poll_fn;
    use std::pin::Pin;
    // Fully-qualified call: keep trait method without a potentially-unused import on some cfgs.
    poll_fn(|cx| zbus::export::futures_core::Stream::poll_next(Pin::new(&mut *stream), cx)).await
}
